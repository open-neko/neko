-- Default-deny app/object/field entitlements. record_permission remains the
-- schema-level role ceiling; these grants choose which users/groups may use it.

create table if not exists engine.entitlement_revision (
  org_id text primary key,
  revision bigint not null default 0 check (revision >= 0),
  updated_at timestamptz not null default now()
);

create table if not exists engine.app_access_grant (
  org_id text not null,
  app_id text not null,
  subject_type text not null check (subject_type in ('user', 'group', 'role')),
  subject_id text not null check (length(subject_id) > 0),
  created_by_user_id text,
  action_request_id text,
  created_at timestamptz not null default now(),
  primary key (org_id, app_id, subject_type, subject_id),
  foreign key (org_id, app_id)
    references engine.record_app (org_id, app_id) on delete cascade
);

create table if not exists engine.object_access_grant (
  org_id text not null,
  app_id text not null,
  subject_type text not null check (subject_type in ('user', 'group', 'role')),
  subject_id text not null check (length(subject_id) > 0),
  object_api_name text not null,
  can_read boolean not null default false,
  can_create boolean not null default false,
  can_update boolean not null default false,
  can_delete boolean not null default false,
  created_by_user_id text,
  action_request_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, app_id, subject_type, subject_id, object_api_name),
  foreign key (org_id, app_id, subject_type, subject_id)
    references engine.app_access_grant (org_id, app_id, subject_type, subject_id)
    on delete cascade,
  foreign key (org_id, app_id, object_api_name)
    references engine.record_object (org_id, app_id, api_name) on delete cascade,
  check (not (can_create or can_update or can_delete) or can_read)
);

create table if not exists engine.field_access_grant (
  org_id text not null,
  app_id text not null,
  subject_type text not null check (subject_type in ('user', 'group', 'role')),
  subject_id text not null check (length(subject_id) > 0),
  object_api_name text not null,
  field_id uuid not null,
  can_read boolean not null default false,
  can_write boolean not null default false,
  created_by_user_id text,
  action_request_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, app_id, subject_type, subject_id, field_id),
  foreign key (org_id, app_id, subject_type, subject_id, object_api_name)
    references engine.object_access_grant
      (org_id, app_id, subject_type, subject_id, object_api_name)
    on delete cascade,
  foreign key (field_id, org_id)
    references engine.record_field (id, org_id) on delete cascade,
  check (not can_write or can_read)
);

create index if not exists app_access_subject_idx
  on engine.app_access_grant (org_id, subject_type, subject_id, app_id);
create index if not exists object_access_subject_idx
  on engine.object_access_grant
    (org_id, subject_type, subject_id, app_id, object_api_name);
create index if not exists field_access_subject_idx
  on engine.field_access_grant (org_id, subject_type, subject_id, app_id, field_id);

create table if not exists engine.entitlement_audit (
  id bigint generated always as identity primary key,
  org_id text not null,
  app_id text not null,
  subject_type text not null check (subject_type in ('user', 'group', 'role')),
  subject_id text not null,
  resource_kind text not null check (resource_kind in ('app', 'object', 'field')),
  resource_id text not null,
  operation text not null check (operation in ('grant', 'set', 'revoke', 'migration')),
  before_value jsonb,
  after_value jsonb,
  actor_user_id text,
  action_request_id text,
  at timestamptz not null default now()
);
create index if not exists entitlement_audit_recent_idx
  on engine.entitlement_audit (org_id, app_id, at desc);

create or replace function engine.bump_entitlement_revision()
returns trigger language plpgsql as $$
declare target_org text;
begin
  if tg_op = 'DELETE' then
    target_org := old.org_id;
  else
    target_org := new.org_id;
  end if;
  insert into engine.entitlement_revision (org_id, revision)
  values (target_org, 1)
  on conflict (org_id) do update
    set revision = engine.entitlement_revision.revision + 1,
        updated_at = now();
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists app_access_revision on engine.app_access_grant;
create trigger app_access_revision after insert or update or delete
  on engine.app_access_grant for each row execute function engine.bump_entitlement_revision();
drop trigger if exists object_access_revision on engine.object_access_grant;
create trigger object_access_revision after insert or update or delete
  on engine.object_access_grant for each row execute function engine.bump_entitlement_revision();
drop trigger if exists field_access_revision on engine.field_access_grant;
create trigger field_access_revision after insert or update or delete
  on engine.field_access_grant for each row execute function engine.bump_entitlement_revision();

-- Upgrade compatibility: turn every existing role permission into an explicit
-- role-subject entitlement. New app projection does not create these rows.
insert into engine.app_access_grant
  (org_id, app_id, subject_type, subject_id, created_by_user_id, action_request_id)
select distinct org_id, app_id, 'role', role, null, null
from engine.record_permission
where can_read or can_create or can_update or can_delete
on conflict do nothing;

insert into engine.object_access_grant
  (org_id, app_id, subject_type, subject_id, object_api_name,
   can_read, can_create, can_update, can_delete)
select org_id, app_id, 'role', role, object_api_name,
       can_read or can_create or can_update or can_delete,
       can_create, can_update, can_delete
from engine.record_permission
where can_read or can_create or can_update or can_delete
on conflict (org_id, app_id, subject_type, subject_id, object_api_name)
do update set
  can_read = excluded.can_read,
  can_create = excluded.can_create,
  can_update = excluded.can_update,
  can_delete = excluded.can_delete,
  updated_at = now();

insert into engine.field_access_grant
  (org_id, app_id, subject_type, subject_id, object_api_name, field_id,
   can_read, can_write)
select p.org_id, p.app_id, 'role', p.role, p.object_api_name, f.id,
       p.can_read or p.can_create or p.can_update or p.can_delete,
       (p.can_create or p.can_update) and not f.read_only
from engine.record_permission p
join engine.record_object o
  on o.org_id = p.org_id and o.app_id = p.app_id
 and o.api_name = p.object_api_name
join engine.record_field f
  on f.org_id = o.org_id and f.object_id = o.id
where f.archived_at is null
  and (p.can_read or p.can_create or p.can_update or p.can_delete)
on conflict (org_id, app_id, subject_type, subject_id, field_id)
do update set
  can_read = excluded.can_read,
  can_write = excluded.can_write,
  updated_at = now();

insert into engine.entitlement_audit
  (org_id, app_id, subject_type, subject_id, resource_kind, resource_id,
   operation, after_value)
select org_id, app_id, 'role', role, 'object', object_api_name, 'migration',
       jsonb_build_object(
         'canRead', can_read,
         'canCreate', can_create,
         'canUpdate', can_update,
         'canDelete', can_delete
       )
from engine.record_permission
where can_read or can_create or can_update or can_delete;
