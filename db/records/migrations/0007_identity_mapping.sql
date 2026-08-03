-- Source identities are scoped by connector instance. Add the lookup and
-- uniqueness structures needed for deterministic import-time and lazy SSO
-- linking without treating an external id as globally unique.

alter table engine.identity_map
  add column if not exists source_email_normalized text
    generated always as (lower(btrim(source_email))) stored,
  add column if not exists updated_at timestamptz not null default now();

create index if not exists identity_map_email_status_idx
  on engine.identity_map (org_id, source_email_normalized, status);

create index if not exists identity_map_app_status_idx
  on engine.identity_map (org_id, app_id, status, updated_at desc);

create unique index if not exists identity_map_one_source_user_per_app_user_idx
  on engine.identity_map
    (org_id, source_instance_id, app_id, app_user_id)
  where status = 'linked' and app_user_id is not null;
