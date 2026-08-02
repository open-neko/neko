package cli

import (
	"context"
	"fmt"
	"regexp"
	"time"

	"github.com/spf13/cobra"
)

var recordsCLIIdentifier = regexp.MustCompile(`^[a-z_][a-z0-9_]*$`)

const recordsDropSQL = `
begin;
set local lock_timeout = '10s';
set local statement_timeout = '2min';
select
  set_config('openneko.drop_app_id', :'app_id', true) as drop_app_setting,
  set_config('openneko.drop_object_api_name', :'object_api_name', true) as drop_object_setting,
  set_config('openneko.drop_org_id', :'org_id', true) as drop_org_setting
\gset
do $drop$
declare
  requested_app text := current_setting('openneko.drop_app_id');
  requested_object text := current_setting('openneko.drop_object_api_name');
  requested_org text := current_setting('openneko.drop_org_id');
  target record;
  matches integer;
begin
  select count(*)::integer into matches
  from engine.record_object o
  where o.app_id = requested_app
    and o.api_name = requested_object
    and (requested_org = '' or o.org_id = requested_org);

  if matches = 0 then
    raise exception 'records object %.% was not found', requested_app, requested_object;
  end if;
  if matches > 1 then
    raise exception 'records object %.% exists in multiple organizations; pass --org',
      requested_app, requested_object;
  end if;

  select o.id, o.org_id, o.app_id, o.api_name, o.table_schema, o.table_name,
         o.archived_at
  into strict target
  from engine.record_object o
  where o.app_id = requested_app
    and o.api_name = requested_object
    and (requested_org = '' or o.org_id = requested_org);

  if target.archived_at is null then
    raise exception 'records object %.% must be archived before hard drop',
      target.app_id, target.api_name;
  end if;

  insert into engine.app_schema_log (org_id, app_id, action, detail)
  values (
    target.org_id,
    target.app_id,
    'hard_drop',
    jsonb_build_object(
      'object_api_name', target.api_name,
      'table_schema', target.table_schema,
      'table_name', target.table_name,
      'archived_at', target.archived_at,
      'initiated_by', 'openneko records drop'
    )
  );

  execute format('drop table if exists %I.%I', target.table_schema, target.table_name);
  delete from engine.record_object where id = target.id and org_id = target.org_id;
  update engine.record_app
  set registry_revision = registry_revision + 1,
      updated_at = now()
  where org_id = target.org_id and app_id = target.app_id;
  insert into engine.registry_version (org_id, revision, updated_at)
  values (target.org_id, 1, now())
  on conflict (org_id) do update
  set revision = engine.registry_version.revision + 1,
      updated_at = excluded.updated_at;
end
$drop$;
commit;
`

func newRecordsCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "records",
		Short: "Perform guarded records-engine operations",
	}
	cmd.AddCommand(newRecordsDropCmd())
	return cmd
}

func newRecordsDropCmd() *cobra.Command {
	var appID string
	var objectAPIName string
	var orgID string
	var confirmation string
	cmd := &cobra.Command{
		Use:   "drop --app <app> --object <object> --confirm 'DROP <app>.<object>'",
		Short: "Permanently drop an archived records object and its data",
		Long: `Permanently remove an archived records object's physical table and registry
entry. The operation refuses active objects and requires both an exact typed
confirmation and a fresh, successfully restore-verified whole-deployment backup.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if err := validateRecordsDropInput(appID, objectAPIName, confirmation); err != nil {
				return err
			}
			return runRecordsDrop(cmd.Context(), cmd, orgID, appID, objectAPIName)
		},
	}
	cmd.Flags().StringVar(&appID, "app", "", "records app API identifier (required)")
	cmd.Flags().StringVar(&objectAPIName, "object", "", "records object API identifier (required)")
	cmd.Flags().StringVar(&orgID, "org", "", "organization identifier (required only when the app/object is ambiguous)")
	cmd.Flags().StringVar(&confirmation, "confirm", "", "type DROP <app>.<object> to allow permanent deletion")
	_ = cmd.MarkFlagRequired("app")
	_ = cmd.MarkFlagRequired("object")
	return cmd
}

func validateRecordsDropInput(appID, objectAPIName, confirmation string) error {
	if !validRecordsCLIIdentifier(appID) {
		return fmt.Errorf("--app must be a persisted records API identifier")
	}
	if !validRecordsCLIIdentifier(objectAPIName) {
		return fmt.Errorf("--object must be a persisted records API identifier")
	}
	want := recordsDropConfirmation(appID, objectAPIName)
	if confirmation != want {
		return fmt.Errorf("hard drop permanently deletes records data; pass --confirm %q exactly", want)
	}
	return nil
}

func validRecordsCLIIdentifier(value string) bool {
	return len(value) > 0 && len(value) <= 63 && recordsCLIIdentifier.MatchString(value)
}

func recordsDropConfirmation(appID, objectAPIName string) string {
	return fmt.Sprintf("DROP %s.%s", appID, objectAPIName)
}

func runRecordsDrop(
	ctx context.Context,
	cmd *cobra.Command,
	orgID string,
	appID string,
	objectAPIName string,
) error {
	_, _, project, files, err := currentStackCompose()
	if err != nil {
		return err
	}
	if err := requireFreshVerifiedBackupFor(ctx, project, files, time.Now(), "records drop"); err != nil {
		return err
	}

	_, err = composeCommandOutput(ctx, project, files,
		"exec", "-T", "records-db", "sh", "-ec",
		`printf '%s\n' "$4" | psql -X -Atq -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v app_id="$1" -v object_api_name="$2" -v org_id="$3"`,
		"records-drop", appID, objectAPIName, orgID, recordsDropSQL)
	if err != nil {
		return fmt.Errorf("records drop failed: %w", err)
	}
	fmt.Fprintf(cmd.OutOrStdout(), "Permanently dropped archived records object %s.%s", appID, objectAPIName)
	if orgID != "" {
		fmt.Fprintf(cmd.OutOrStdout(), " for organization %s", orgID)
	}
	fmt.Fprintln(cmd.OutOrStdout(), ". The hard drop was recorded in the schema audit log.")
	return nil
}
