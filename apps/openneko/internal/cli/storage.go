package cli

import (
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/spf13/cobra"

	"github.com/open-neko/neko/apps/openneko/internal/config"
	"github.com/open-neko/neko/apps/openneko/internal/db"
)

func newStorageCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "storage",
		Short: "Inspect or reconcile the enforced database storage contract",
	}
	cmd.AddCommand(newStorageContractCmd(), newStorageReconcileCmd())
	return cmd
}

func newStorageContractCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "contract",
		Short: "Print the storage contract compiled into this OpenNeko release",
		Args:  cobra.NoArgs,
		Run: func(cmd *cobra.Command, _ []string) {
			fmt.Fprintln(cmd.OutOrStdout(), db.StorageContractVersion)
		},
	}
}

func newStorageReconcileCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "reconcile",
		Short: "Reconcile both managed databases before application startup",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			ctx := cmd.Context()
			out := cmd.OutOrStdout()
			targets := []struct {
				name   string
				config db.ConnConfig
			}{
				{name: "metadata", config: defaultConn()},
				{name: "records", config: recordsConn()},
			}
			for _, target := range targets {
				conn, err := pgx.Connect(ctx, target.config.DSN())
				if err != nil {
					return fmt.Errorf("connect to %s database: %w", target.name, err)
				}
				repaired, reconcileErr := db.ReconcileStorage(ctx, conn, func(format string, args ...any) {
					fmt.Fprintf(out, format+"\n", args...)
				})
				closeErr := conn.Close(ctx)
				if reconcileErr != nil {
					return fmt.Errorf("reconcile %s database: %w", target.name, reconcileErr)
				}
				if closeErr != nil {
					return fmt.Errorf("close %s database connection: %w", target.name, closeErr)
				}
				if repaired {
					fmt.Fprintf(out, "%s database storage repaired\n", target.name)
				}
			}
			fmt.Fprintf(out, "both databases satisfy storage contract %d\n", db.StorageContractVersion)
			return nil
		},
	}
}

// recordsConn resolves the records data-plane connection with the same
// local-config-over-environment precedence used by every other runtime.
func recordsConn() db.ConnConfig {
	conn := db.ConnConfig{
		Host:     envOr("RECORDS_PG_HOST", "127.0.0.1"),
		Port:     envInt("RECORDS_PG_PORT", envInt("OPENNEKO_RECORDS_DB_PORT", 5434)),
		User:     envOr("RECORDS_PG_USER", "records"),
		Password: envOr("RECORDS_PG_PASSWORD", "records-secret"),
		Database: envOr("RECORDS_PG_DATABASE", "records"),
		SSLMode:  envOr("RECORDS_PG_SSLMODE", "disable"),
	}
	local, _ := config.ReadLocal("")
	if local.RecordsPg != nil {
		if local.RecordsPg.Host != "" {
			conn.Host = local.RecordsPg.Host
		}
		if local.RecordsPg.Port != 0 {
			conn.Port = local.RecordsPg.Port
		}
		if local.RecordsPg.User != "" {
			conn.User = local.RecordsPg.User
		}
		if local.RecordsPg.Password != "" {
			conn.Password = local.RecordsPg.Password
		}
		if local.RecordsPg.Database != "" {
			conn.Database = local.RecordsPg.Database
		}
		if local.RecordsPg.SSLMode != "" {
			conn.SSLMode = local.RecordsPg.SSLMode
		}
	}
	return conn
}
