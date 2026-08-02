-- Records engine control schema. Business-object tables live in public and
-- are created only through GraphJin DDL; OpenNeko-authored SQL is limited to
-- this engine-owned registry and operational state.

create schema if not exists engine;

create table if not exists engine.registry_version (
  org_id text primary key,
  revision bigint not null default 0 check (revision >= 0),
  updated_at timestamptz not null default now()
);

create table if not exists engine.record_app (
  app_id text not null,
  org_id text not null,
  label text not null,
  purpose text,
  status text not null default 'draft'
    check (status in ('draft', 'provisioning', 'importing', 'active', 'degraded', 'archived')),
  nav_order integer not null default 0,
  registry_revision bigint not null default 0 check (registry_revision >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, app_id)
);

create table if not exists engine.record_object (
  id uuid primary key default gen_random_uuid(),
  org_id text not null,
  app_id text not null,
  api_name text not null,
  source_api_name text,
  label text not null,
  plural_label text not null,
  table_schema text not null default 'public',
  table_name text not null,
  name_field text not null default 'name',
  visibility text not null default 'org' check (visibility in ('org', 'owner')),
  is_custom boolean not null default false,
  archived_at timestamptz,
  record_count bigint check (record_count is null or record_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, org_id),
  unique (org_id, app_id, api_name),
  unique (table_schema, table_name),
  foreign key (org_id, app_id)
    references engine.record_app (org_id, app_id) on delete cascade
);

create table if not exists engine.record_field (
  id uuid primary key default gen_random_uuid(),
  org_id text not null,
  object_id uuid not null,
  api_name text not null,
  source_api_name text,
  label text not null,
  kind text not null check (kind in (
    'id', 'text', 'textarea', 'boolean', 'integer', 'decimal', 'currency',
    'percent', 'date', 'datetime', 'email', 'phone', 'url', 'picklist',
    'multipicklist', 'reference', 'readonly_formula'
  )),
  column_name text not null,
  required boolean not null default false,
  read_only boolean not null default false,
  archived_at timestamptz,
  picklist_values jsonb,
  reference_targets jsonb,
  length integer check (length is null or length > 0),
  scale integer check (scale is null or scale >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, org_id),
  unique (object_id, api_name),
  unique (object_id, column_name),
  foreign key (object_id, org_id)
    references engine.record_object (id, org_id) on delete cascade
);

create table if not exists engine.record_relationship (
  id uuid primary key default gen_random_uuid(),
  org_id text not null,
  from_object uuid not null,
  from_field uuid not null,
  to_object uuid not null,
  relationship_label text,
  unique (from_field),
  foreign key (from_object, org_id)
    references engine.record_object (id, org_id) on delete cascade,
  foreign key (from_field, org_id)
    references engine.record_field (id, org_id) on delete cascade,
  foreign key (to_object, org_id)
    references engine.record_object (id, org_id) on delete cascade
);

create table if not exists engine.record_layout (
  object_id uuid not null,
  org_id text not null,
  kind text not null default 'detail' check (kind in ('detail', 'list')),
  definition jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (object_id, kind),
  foreign key (object_id, org_id)
    references engine.record_object (id, org_id) on delete cascade
);

create table if not exists engine.app_page (
  id uuid primary key default gen_random_uuid(),
  org_id text not null,
  app_id text not null,
  api_name text not null,
  label text not null,
  definition jsonb not null,
  nav_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, app_id, api_name),
  foreign key (org_id, app_id)
    references engine.record_app (org_id, app_id) on delete cascade
);

create table if not exists engine.saved_view (
  id uuid primary key default gen_random_uuid(),
  org_id text not null,
  object_id uuid not null,
  owner_user_id text,
  label text not null,
  definition jsonb not null,
  shared boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique nulls not distinct (org_id, object_id, owner_user_id, label),
  foreign key (object_id, org_id)
    references engine.record_object (id, org_id) on delete cascade
);

create table if not exists engine.record_permission (
  org_id text not null,
  app_id text not null,
  role text not null,
  object_api_name text not null,
  can_read boolean not null default false,
  can_create boolean not null default false,
  can_update boolean not null default false,
  can_delete boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (org_id, app_id, role, object_api_name),
  foreign key (org_id, app_id)
    references engine.record_app (org_id, app_id) on delete cascade,
  foreign key (org_id, app_id, object_api_name)
    references engine.record_object (org_id, app_id, api_name) on delete cascade
);

create table if not exists engine.actor (
  org_id text not null,
  user_id text not null,
  role text not null check (role in ('admin', 'member', 'service')),
  disabled_at timestamptz,
  synced_at timestamptz not null default now(),
  primary key (org_id, user_id)
);

create table if not exists engine.record_change_log (
  id bigint generated always as identity primary key,
  org_id text not null,
  app_id text not null,
  object_api_name text not null,
  record_id text not null,
  action text not null check (action in ('create', 'update', 'delete', 'restore', 'import', 'sync')),
  actor_user_id text,
  action_request_id text,
  mutation_id text not null,
  operation_seq integer not null default 0 check (operation_seq >= 0),
  changes jsonb not null,
  at timestamptz not null default now(),
  unique (mutation_id),
  foreign key (org_id, app_id)
    references engine.record_app (org_id, app_id)
);

create index if not exists record_change_log_record_recent_idx
  on engine.record_change_log (org_id, object_api_name, record_id, at desc);
create index if not exists record_change_log_request_idx
  on engine.record_change_log (action_request_id, operation_seq)
  where action_request_id is not null;

create table if not exists engine.action_execution (
  action_request_id text primary key,
  org_id text not null,
  app_id text,
  action_kind text not null,
  status text not null check (status in ('claimed', 'running', 'succeeded', 'failed')),
  lease_owner text,
  lease_expires_at timestamptz,
  result jsonb,
  error jsonb,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  foreign key (org_id, app_id)
    references engine.record_app (org_id, app_id)
);

create index if not exists action_execution_reclaim_idx
  on engine.action_execution (status, lease_expires_at)
  where status in ('claimed', 'running');

create table if not exists engine.app_schema_change (
  id uuid primary key default gen_random_uuid(),
  org_id text not null,
  app_id text not null,
  action_request_id text not null unique,
  desired_revision bigint not null check (desired_revision > 0),
  catalog_revision text not null,
  graphjin_ddl jsonb not null,
  preview_sql text not null,
  preview_hash text not null,
  phase text not null check (phase in (
    'planned', 'approved', 'applying', 'applied', 'projected', 'failed'
  )),
  attempts integer not null default 0 check (attempts >= 0),
  last_error jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, app_id, desired_revision),
  foreign key (org_id, app_id)
    references engine.record_app (org_id, app_id)
);

create index if not exists app_schema_change_reconcile_idx
  on engine.app_schema_change (phase, updated_at)
  where phase not in ('projected', 'failed');

create table if not exists engine.app_schema_log (
  id bigint generated always as identity primary key,
  org_id text not null,
  app_id text not null,
  action text not null check (action in (
    'app_create', 'object_create', 'field_add', 'field_modify',
    'object_archive', 'field_archive', 'permission_set', 'layout_update',
    'page_update', 'hard_drop'
  )),
  detail jsonb not null,
  ddl jsonb,
  actor_user_id text,
  action_request_id text,
  at timestamptz not null default now(),
  foreign key (org_id, app_id)
    references engine.record_app (org_id, app_id)
);

create index if not exists app_schema_log_app_recent_idx
  on engine.app_schema_log (org_id, app_id, at desc);

create table if not exists engine.identity_map (
  org_id text not null,
  source_instance_id text not null,
  app_id text not null,
  source_user_id text not null,
  source_email text not null,
  source_name text,
  source_is_active boolean,
  app_user_id text,
  status text not null default 'unlinked'
    check (status in ('linked', 'unlinked', 'conflict', 'ignored')),
  linked_at timestamptz,
  primary key (org_id, source_instance_id, app_id, source_user_id),
  foreign key (org_id, app_id)
    references engine.record_app (org_id, app_id) on delete cascade
);

create table if not exists engine.import_run (
  id uuid primary key,
  org_id text not null,
  app_id text not null,
  action_request_id text not null unique,
  source_instance_id text,
  status text not null check (status in ('planned', 'running', 'succeeded', 'failed', 'cancelled')),
  plan_hash text not null,
  current_stage text,
  result jsonb,
  error jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (org_id, app_id)
    references engine.record_app (org_id, app_id)
);

create table if not exists engine.import_batch_receipt (
  import_run_id uuid not null references engine.import_run(id) on delete cascade,
  object_api_name text not null,
  batch_no integer not null check (batch_no >= 0),
  batch_hash text not null,
  row_count integer not null check (row_count >= 0),
  committed_at timestamptz not null default now(),
  primary key (import_run_id, object_api_name, batch_no),
  unique (import_run_id, batch_hash)
);

create table if not exists engine.sync_cursor (
  org_id text not null,
  app_id text not null,
  source_instance_id text not null,
  object_api_name text not null,
  watermark jsonb not null,
  last_batch_hash text not null,
  updated_at timestamptz not null default now(),
  primary key (org_id, app_id, source_instance_id, object_api_name),
  foreign key (org_id, app_id)
    references engine.record_app (org_id, app_id) on delete cascade
);
