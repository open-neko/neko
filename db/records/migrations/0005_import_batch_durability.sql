-- Crash-safe CSV import progress. Import batches still write app rows only
-- through GraphJin; the app-table audit trigger advances the target-side
-- receipt in that same GraphJin transaction.

alter table engine.import_run
  add column if not exists cancel_requested_at timestamptz;

create table if not exists engine.import_reject (
  import_run_id uuid not null references engine.import_run(id) on delete cascade,
  object_api_name text not null,
  row_number integer not null check (row_number > 0),
  row_hash text not null,
  reason_code text not null,
  reason text not null,
  source_row jsonb not null,
  created_at timestamptz not null default now(),
  primary key (import_run_id, object_api_name, row_number)
);

create index if not exists import_reject_run_reason_idx
  on engine.import_reject (import_run_id, reason_code, row_number);

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

insert into engine.substrate_version (name, version)
values ('record_audit_trigger', 2)
on conflict (name) do update
set version = excluded.version,
    updated_at = now();
