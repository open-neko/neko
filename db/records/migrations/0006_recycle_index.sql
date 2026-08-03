-- A narrow, engine-owned index makes soft-deleted record identities readable
-- through GraphJin without relaxing the not-deleted policy on business tables.
-- It deliberately stores no business payload: restore needs an exact id and
-- human-readable name, while normal field visibility remains fail-closed.

create table if not exists engine.recycle_record (
  org_id text not null,
  app_id text not null,
  object_api_name text not null,
  scope_key text generated always as (app_id || '.' || object_api_name) stored,
  visibility text not null check (visibility in ('org', 'owner')),
  record_id text not null,
  record_name text not null,
  owner_user_id text,
  deleted_at timestamptz not null,
  deleted_by text,
  deletion_action_request_id text not null,
  primary key (org_id, app_id, object_api_name, record_id),
  foreign key (org_id, app_id, object_api_name)
    references engine.record_object (org_id, app_id, api_name) on delete cascade
);

create index if not exists recycle_record_object_recent_idx
  on engine.recycle_record (org_id, app_id, object_api_name, deleted_at desc, record_id);
create index if not exists recycle_record_owner_recent_idx
  on engine.recycle_record (org_id, owner_user_id, deleted_at desc)
  where owner_user_id is not null;

create or replace function engine.capture_record_change()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, engine
as $$
declare
  new_row jsonb := to_jsonb(new);
  old_row jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) else '{}'::jsonb end;
  v_action_kind text;
  v_action_context jsonb;
  v_change_action text;
  v_actor_user_id text;
  v_action_request_id text;
  v_mutation_id text;
  v_changes jsonb;
  v_name_field text;
  v_visibility text;
  v_import_run_id uuid;
  v_import_object_api_name text;
  v_import_batch_no integer;
  v_import_batch_hash text;
begin
  if tg_nargs <> 2 or tg_argv[0] = '' or tg_argv[1] = '' then
    raise exception 'records audit trigger requires app and object identifiers';
  end if;

  if new_row->>'org_id' is null or new_row->>'id' is null then
    raise exception 'records audit trigger requires org_id and id';
  end if;

  v_action_request_id := new_row->>'nk_action_request_id';
  v_mutation_id := new_row->>'nk_mutation_id';
  v_actor_user_id := coalesce(new_row->>'nk_updated_by', new_row->>'nk_created_by');
  if v_action_request_id is null or v_action_request_id = '' then
    raise exception 'records mutation requires nk_action_request_id';
  end if;
  if v_mutation_id is null or v_mutation_id = '' then
    raise exception 'records mutation requires nk_mutation_id';
  end if;

  select ae.action_kind, ae.result into v_action_kind, v_action_context
  from engine.action_execution ae
  where ae.action_request_id = v_action_request_id
    and ae.status in ('claimed', 'running');
  if v_action_kind is null then
    raise exception 'records mutation requires a live action execution claim';
  end if;

  if tg_op = 'INSERT' then
    v_change_action := case
      when v_action_kind in ('record_import', 'app_import', 'records_import_start') then 'import'
      when v_action_kind in ('record_sync', 'app_sync') then 'sync'
      else 'create'
    end;
  elsif old_row->>'nk_deleted_at' is null
      and new_row->>'nk_deleted_at' is not null then
    v_change_action := 'delete';
  elsif old_row->>'nk_deleted_at' is not null
      and new_row->>'nk_deleted_at' is null then
    v_change_action := 'restore';
  else
    v_change_action := case
      when v_action_kind in ('record_import', 'app_import', 'records_import_start') then 'import'
      when v_action_kind in ('record_sync', 'app_sync') then 'sync'
      else 'update'
    end;
  end if;

  select coalesce(
    jsonb_object_agg(
      keys.key,
      jsonb_build_object('old', old_row->keys.key, 'new', new_row->keys.key)
      order by keys.key
    ),
    '{}'::jsonb
  ) into v_changes
  from (
    select key from jsonb_object_keys(old_row || new_row) as key
    where key <> 'org_id'
      and key not like 'nk\_%' escape '\'
      and old_row->key is distinct from new_row->key
  ) as keys;

  insert into engine.record_change_log (
    org_id,
    app_id,
    object_api_name,
    record_id,
    action,
    actor_user_id,
    action_request_id,
    mutation_id,
    changes
  ) values (
    new_row->>'org_id',
    tg_argv[0],
    tg_argv[1],
    new_row->>'id',
    v_change_action,
    v_actor_user_id,
    v_action_request_id,
    v_mutation_id,
    v_changes
  ) on conflict (mutation_id) do nothing;

  if v_change_action in ('delete', 'restore') then
    select ro.name_field, ro.visibility into v_name_field, v_visibility
    from engine.record_object ro
    where ro.org_id = new_row->>'org_id'
      and ro.app_id = tg_argv[0]
      and ro.api_name = tg_argv[1];
    if v_name_field is null then
      raise exception 'records recycle mutation requires a registered object';
    end if;
  end if;

  if v_change_action = 'delete' then
    insert into engine.recycle_record (
      org_id,
      app_id,
      object_api_name,
      visibility,
      record_id,
      record_name,
      owner_user_id,
      deleted_at,
      deleted_by,
      deletion_action_request_id
    ) values (
      new_row->>'org_id',
      tg_argv[0],
      tg_argv[1],
      v_visibility,
      new_row->>'id',
      coalesce(new_row->>v_name_field, new_row->>'id'),
      new_row->>'owner_user_id',
      (new_row->>'nk_deleted_at')::timestamptz,
      v_actor_user_id,
      v_action_request_id
    )
    on conflict (org_id, app_id, object_api_name, record_id) do update
      set visibility = excluded.visibility,
          record_name = excluded.record_name,
          owner_user_id = excluded.owner_user_id,
          deleted_at = excluded.deleted_at,
          deleted_by = excluded.deleted_by,
          deletion_action_request_id = excluded.deletion_action_request_id;
  elsif v_change_action = 'restore' then
    delete from engine.recycle_record
    where org_id = new_row->>'org_id'
      and app_id = tg_argv[0]
      and object_api_name = tg_argv[1]
      and record_id = new_row->>'id';
  end if;

  if v_action_kind in ('record_import', 'app_import', 'records_import_start') then
    begin
      v_import_run_id := (v_action_context #>> '{import_batch,run_id}')::uuid;
      v_import_object_api_name := v_action_context #>> '{import_batch,object_api_name}';
      v_import_batch_no := (v_action_context #>> '{import_batch,batch_no}')::integer;
      v_import_batch_hash := v_action_context #>> '{import_batch,batch_hash}';
    exception when others then
      raise exception 'records import mutation has invalid batch context';
    end;
    if v_import_run_id is null
       or v_import_object_api_name is null
       or v_import_object_api_name <> tg_argv[1]
       or v_import_batch_no is null
       or v_import_batch_no < 0
       or v_import_batch_hash is null
       or v_import_batch_hash = '' then
      raise exception 'records import mutation requires complete matching batch context';
    end if;

    insert into engine.import_batch_receipt (
      import_run_id, object_api_name, batch_no, batch_hash, row_count
    ) values (
      v_import_run_id, v_import_object_api_name, v_import_batch_no,
      v_import_batch_hash, 1
    )
    on conflict (import_run_id, object_api_name, batch_no) do update
      set row_count = engine.import_batch_receipt.row_count + 1
      where engine.import_batch_receipt.batch_hash = excluded.batch_hash;

    if not found then
      raise exception 'records import batch receipt identity mismatch';
    end if;
  end if;

  return new;
end;
$$;

-- Existing soft-deleted rows predate the index. Backfill them from only the
-- registered tables and identifier columns already approved in the registry.
do $$
declare
  object_row record;
  owner_expression text;
begin
  for object_row in
    select org_id, app_id, api_name, table_schema, table_name, name_field, visibility
    from engine.record_object
    where archived_at is null
  loop
    if to_regclass(format('%I.%I', object_row.table_schema, object_row.table_name)) is null then
      continue;
    end if;
    owner_expression := case
      when object_row.visibility = 'owner' then 'owner_user_id'
      else 'null::text'
    end;
    execute format(
      'insert into engine.recycle_record
         (org_id, app_id, object_api_name, visibility, record_id, record_name,
          owner_user_id, deleted_at, deleted_by, deletion_action_request_id)
       select org_id, %L, %L, %L, id, coalesce(%I::text, id), %s,
              nk_deleted_at, nk_updated_by, nk_action_request_id
       from %I.%I
       where org_id = %L and nk_deleted_at is not null
       on conflict (org_id, app_id, object_api_name, record_id) do update
         set visibility = excluded.visibility,
             record_name = excluded.record_name,
             owner_user_id = excluded.owner_user_id,
             deleted_at = excluded.deleted_at,
             deleted_by = excluded.deleted_by,
             deletion_action_request_id = excluded.deletion_action_request_id',
      object_row.app_id,
      object_row.api_name,
      object_row.visibility,
      object_row.name_field,
      owner_expression,
      object_row.table_schema,
      object_row.table_name,
      object_row.org_id
    );
  end loop;
end;
$$;

insert into engine.substrate_version (name, version)
values ('record_audit_trigger', 3)
on conflict (name) do update
set version = excluded.version,
    updated_at = now();
