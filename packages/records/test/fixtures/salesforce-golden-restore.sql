-- Restored projection of the twelve-object Salesforce golden artifact. The
-- recovery harness backs this up and proves all 24 reconciliation outcomes,
-- including the two intentional rejects, survive a throwaway restore.

create table if not exists public.openneko_salesforce_golden_restore_fixture (
  object_api_name text not null,
  row_number integer not null,
  disposition text not null check (disposition in ('accepted', 'rejected')),
  row_hash text not null check (length(row_hash) = 64),
  primary key (object_api_name, row_number)
);

truncate table public.openneko_salesforce_golden_restore_fixture;

insert into public.openneko_salesforce_golden_restore_fixture
  (object_api_name, row_number, disposition, row_hash)
select object_api_name,
       row_number,
       case
         when (object_api_name = 'case_nk' and row_number = 2)
           or (object_api_name = 'product2' and row_number = 2)
         then 'rejected'
         else 'accepted'
       end,
       md5(object_api_name || ':' || row_number::text) ||
         md5(row_number::text || ':' || object_api_name)
from unnest(array[
  'account',
  'campaign',
  'campaignmember',
  'case_nk',
  'contact',
  'event',
  'lead',
  'opportunity',
  'product2',
  'subscription__c',
  'task',
  'user_nk'
]) as object_api_name
cross join generate_series(1, 2) as row_number;
