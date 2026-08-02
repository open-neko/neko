package cli

import (
	"context"
	"fmt"
	"os"
	"time"

	"github.com/spf13/cobra"
)

func newRestoreCmd() *cobra.Command {
	var target string
	cmd := &cobra.Command{
		Use:   "restore --to <timestamp>",
		Short: "Restore metadata, records, and config to a coordinated point in time",
		Long: `Stop every database consumer, restore the latest complete backup set at or
before the requested UTC timestamp, replay both WAL streams, and reconcile the
records schema before reopening web traffic.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			normalized, err := normalizeRestoreTarget(target, time.Now())
			if err != nil {
				return err
			}
			return runRestore(cmd.Context(), cmd, normalized)
		},
	}
	cmd.Flags().StringVar(&target, "to", "", "UTC RFC3339 recovery target (required)")
	_ = cmd.MarkFlagRequired("to")
	return cmd
}

func normalizeRestoreTarget(raw string, now time.Time) (string, error) {
	if raw == "" {
		return "", fmt.Errorf("--to is required")
	}
	target, err := time.Parse(time.RFC3339Nano, raw)
	if err != nil {
		return "", fmt.Errorf("--to must be an RFC3339 timestamp with a timezone: %w", err)
	}
	target = target.UTC()
	if target.After(now.UTC()) {
		return "", fmt.Errorf("--to cannot be in the future")
	}
	return target.Format(time.RFC3339Nano), nil
}

func runRestore(ctx context.Context, cmd *cobra.Command, target string) error {
	sup, _, project, files, err := currentStackCompose()
	if err != nil {
		return err
	}
	if err := configureOpenShellStateDir(); err != nil {
		return err
	}
	configureOpenShellDBURL()

	stopServices := []string{
		"stop",
		"web",
		"worker",
		"neko-graphjin",
		"records-graphjin",
		"records-watch-graphjin",
		"openshell-gateway",
		"neko-backup",
		"neko-db",
		"records-db",
	}
	fmt.Fprintln(cmd.OutOrStdout(), "Stopping database consumers...")
	if code, err := sup.Run(ctx, project, files, stopServices, os.Stdout, os.Stderr); err != nil {
		return err
	} else if code != 0 {
		return WithExit(code, nil)
	}

	fmt.Fprintf(cmd.OutOrStdout(), "Restoring coordinated state to %s...\n", target)
	restoreArgs := []string{
		"--profile", "ops", "run", "--rm", "--no-deps",
		"neko-restore", "restore", "--to", target,
	}
	if code, err := sup.Run(ctx, project, files, restoreArgs, os.Stdout, os.Stderr); err != nil {
		return err
	} else if code != 0 {
		return WithExit(code, fmt.Errorf("restore failed; stack remains stopped"))
	}

	// Bringing up worker alone starts its database/migration dependencies. Its
	// health endpoint binds only after records schema recovery reconciliation,
	// so --wait establishes the cutover fence before web can serve traffic.
	fmt.Fprintln(cmd.OutOrStdout(), "Reconciling restored records state...")
	workerArgs := []string{"up", "-d", "--wait", "--wait-timeout", "180", "worker"}
	if code, err := sup.Run(ctx, project, files, workerArgs, os.Stdout, os.Stderr); err != nil {
		return err
	} else if code != 0 {
		return WithExit(code, fmt.Errorf("restore succeeded but reconciliation failed; web remains stopped"))
	}

	if code, err := sup.Run(ctx, project, files, []string{"up", "-d"}, os.Stdout, os.Stderr); err != nil {
		return err
	} else if code != 0 {
		return WithExit(code, fmt.Errorf("restore and reconciliation succeeded but stack restart failed"))
	}
	fmt.Fprintf(cmd.OutOrStdout(), "Restore complete at %s; records reconciliation passed before traffic reopened.\n", target)
	return nil
}
