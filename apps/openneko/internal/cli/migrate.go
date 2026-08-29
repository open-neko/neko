package cli

import (
	"fmt"
	"os"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/spf13/cobra"

	"github.com/open-neko/neko/apps/openneko/assets"
	"github.com/open-neko/neko/apps/openneko/internal/db"
)

func newMigrateCmd() *cobra.Command {
	var skipSchema bool
	cmd := &cobra.Command{
		Use:   "migrate",
		Short: "Prepare neko-db schema and the OpenShell gateway role",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			ctx := cmd.Context()
			out := cmd.OutOrStdout()
			gatewayPassword, err := openShellDBPassword()
			if err != nil {
				return fmt.Errorf("resolve OpenShell gateway database credential: %w", err)
			}
			skip := skipSchema || envTruthy("OPENNEKO_SKIP_MIGRATE")
			if !skip {
				conn, err := pgx.Connect(ctx, defaultConn().DSN())
				if err != nil {
					return err
				}
				mig := &db.Migrator{FS: assets.MigrationsFS, Dir: "migrations"}
				ran, migrateErr := mig.Apply(ctx, conn, func(format string, args ...any) {
					fmt.Fprintf(out, format+"\n", args...)
				})
				_ = conn.Close(ctx)
				if migrateErr != nil {
					return migrateErr
				}
				fmt.Fprintf(out, "%d migration(s) applied\n", ran)
			} else {
				fmt.Fprintln(out, "schema migrations skipped")
			}
			if err := ensureOpenShellGatewayRole(ctx, gatewayPassword); err != nil {
				return err
			}
			fmt.Fprintln(out, "OpenShell database role ready")
			return nil
		},
	}
	cmd.Flags().BoolVar(&skipSchema, "skip-schema", false, "Skip schema migrations but still prepare runtime database roles")
	return cmd
}

func envTruthy(name string) bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(name))) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}
