-- Reference metadata permits more than one target object. Preserve one row
-- per target instead of constraining an entire reference field to one row.

alter table engine.record_relationship
  drop constraint if exists record_relationship_from_field_key;

alter table engine.record_relationship
  add constraint record_relationship_from_field_to_object_key
  unique (from_field, to_object);
