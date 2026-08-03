-- GraphJin 3.18.42 creates these tables when its durable artifact/watch
-- control plane first starts. Create the pinned schema during the governed
-- records migration instead, so the exhaustive policy projection sees and
-- blocks the raw store relations before GraphJin can serve any request.

create schema if not exists _graphjin;

create table if not exists _graphjin.artifacts (
  id text primary key,
  name text not null,
  kind text not null,
  path text not null default '',
  source text not null default 'database',
  visibility text not null default 'user',
  read_only boolean not null default false,
  account_id text not null default '',
  owner_id text not null default '',
  content text not null default '',
  content_json jsonb,
  metadata_json jsonb,
  content_hash text not null default '',
  status text not null default 'approved',
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists _graphjin.revisions (
  domain text primary key,
  revision bigint not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists _graphjin.watches (
  id text primary key,
  name text not null,
  description text not null default '',
  query text not null default '',
  saved_query_name text not null default '',
  variables_json jsonb,
  condition_js text not null default '',
  delivery_json jsonb,
  enrich_json jsonb,
  evidence_json jsonb,
  lifecycle text not null default 'durable',
  lease_expires_at timestamptz,
  lease_owner_id text not null default '',
  status text not null default 'active',
  approval text not null default 'approved',
  enabled boolean not null default true,
  account_id text not null default '',
  owner_id text not null default '',
  owner_role text not null default 'user',
  last_data_hash text not null default '',
  last_cursor_json jsonb,
  last_fired_at timestamptz,
  last_error text not null default '',
  failure_count bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_graphjin_watches_owner
  on _graphjin.watches (owner_id);
create index if not exists idx_graphjin_watches_enabled
  on _graphjin.watches (enabled, status);

create table if not exists _graphjin.watch_events (
  id text primary key,
  watch_id text not null,
  data_hash text not null default '',
  data_json jsonb,
  data_truncated boolean not null default false,
  evidence_json jsonb,
  delivery_status text not null default 'pending',
  delivery_attempts bigint not null default 0,
  delivery_json jsonb,
  receipt_json jsonb,
  enrichment_json jsonb,
  seen boolean not null default false,
  seen_at timestamptz,
  account_id text not null default '',
  owner_id text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_graphjin_watch_events_dedup
  on _graphjin.watch_events (watch_id, data_hash);
create index if not exists idx_graphjin_watch_events_owner_seen
  on _graphjin.watch_events (owner_id, seen, created_at);
create index if not exists idx_graphjin_watch_events_delivery
  on _graphjin.watch_events (delivery_status, created_at);
