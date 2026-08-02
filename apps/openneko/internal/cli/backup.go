package cli

import (
	"context"
	"fmt"
	"os"

	"github.com/spf13/cobra"

	"github.com/open-neko/neko/apps/openneko/assets"
	"github.com/open-neko/neko/apps/openneko/internal/compose"
)

func newBackupCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "backup",
		Short: "Inspect or run encrypted whole-deployment backups",
	}
	cmd.AddCommand(
		newBackupOperationCmd("status", "Show backup and restore-verification status", "GET", "/v1/backups/status"),
		newBackupOperationCmd("now", "Create a paired database and config backup now", "POST", "/v1/backups/now"),
		newBackupOperationCmd("verify", "Restore the latest backup into throwaway databases and verify it", "POST", "/v1/backups/verify"),
	)
	return cmd
}

func newBackupOperationCmd(name, short, method, path string) *cobra.Command {
	return &cobra.Command{
		Use:   name,
		Short: short,
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			return runBackupRequest(cmd.Context(), method, path)
		},
	}
}

func currentStackCompose() (*compose.Supervisor, compose.Mode, string, []string, error) {
	if err := configureBackupEnvironment(); err != nil {
		return nil, "", "", nil, fmt.Errorf("configure backup repository: %w", err)
	}
	sup := compose.New(assets.ComposeFS)
	project, err := sup.ProjectName("")
	if err != nil {
		return nil, "", "", nil, err
	}
	mode, ok := compose.ModeFromProjectName(project)
	if !ok {
		mode = compose.ModeProd
	}
	files, err := sup.Materialize(mode)
	if err != nil {
		return nil, "", "", nil, err
	}
	return sup, mode, project, files, nil
}

func runBackupRequest(ctx context.Context, method, path string) error {
	sup, _, project, files, err := currentStackCompose()
	if err != nil {
		return err
	}
	args := []string{
		"exec", "-T", "neko-backup", "curl", "-fsS",
		"-X", method,
		"http://127.0.0.1:9470" + path,
	}
	code, err := sup.Run(ctx, project, files, args, os.Stdout, os.Stderr)
	if err != nil {
		return err
	}
	if code != 0 {
		return WithExit(code, nil)
	}
	return nil
}
