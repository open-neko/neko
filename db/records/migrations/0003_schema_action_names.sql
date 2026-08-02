-- Align the durable journal with the externally visible action kinds. The
-- hard_drop entry remains log-only: it can be written by the guarded admin
-- CLI, but is deliberately not an action adapter kind.

alter table engine.app_schema_log
  drop constraint if exists app_schema_log_action_check;

alter table engine.app_schema_log
  add constraint app_schema_log_action_check check (action in (
    'app_create', 'app_object_create', 'app_field_add', 'app_field_modify',
    'app_object_archive', 'app_field_archive', 'app_permission_set',
    'app_layout_update', 'hard_drop'
  ));
