-- Human-readable change history must preserve the same owner scope as the
-- business row. A second, alphabetically later audit trigger attaches only
-- that policy key after the primary audit trigger writes the durable entry.

alter table engine.record_change_log
  add column if not exists owner_user_id text;

create index if not exists record_change_log_owner_recent_idx
  on engine.record_change_log (org_id, owner_user_id, at desc)
  where owner_user_id is not null;

create or replace function engine.attach_record_change_owner()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, engine
as $$
declare
  new_row jsonb := to_jsonb(new);
begin
  if new_row->>'org_id' is null
     or new_row->>'id' is null
     or new_row->>'nk_mutation_id' is null then
    raise exception 'records owner audit trigger requires org, id, and mutation id';
  end if;

  update engine.record_change_log
  set owner_user_id = new_row->>'owner_user_id'
  where org_id = new_row->>'org_id'
    and mutation_id = new_row->>'nk_mutation_id';

  if not found then
    raise exception 'records owner audit trigger requires a captured change';
  end if;
  return new;
end;
$$;

do $$
declare
  object_row record;
  relation_oid oid;
begin
  for object_row in
    select org_id, app_id, api_name, table_schema, table_name, visibility
    from engine.record_object
    where archived_at is null
  loop
    relation_oid := to_regclass(format('%I.%I', object_row.table_schema, object_row.table_name));
    if relation_oid is null then
      continue;
    end if;
    if not exists (
      select 1 from pg_catalog.pg_trigger
      where tgrelid = relation_oid
        and tgname = 'nk_record_change_owner'
        and not tgisinternal
    ) then
      execute format(
        'create trigger nk_record_change_owner
         after insert or update on %I.%I
         for each row execute function engine.attach_record_change_owner()',
        object_row.table_schema,
        object_row.table_name
      );
    end if;

    if object_row.visibility = 'owner' then
      execute format(
        'update engine.record_change_log l
         set owner_user_id = source.owner_user_id
         from %I.%I source
         where l.org_id = %L and l.app_id = %L and l.object_api_name = %L
           and l.record_id = source.id and source.org_id = l.org_id
           and l.owner_user_id is null',
        object_row.table_schema,
        object_row.table_name,
        object_row.org_id,
        object_row.app_id,
        object_row.api_name
      );
    end if;
  end loop;
end;
$$;

insert into engine.substrate_version (name, version)
values ('record_audit_trigger', 4)
on conflict (name) do update
set version = excluded.version,
    updated_at = now();
