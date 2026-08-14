package cli

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"

	"github.com/spf13/cobra"

	"github.com/open-neko/neko/apps/openneko/assets"
	"github.com/open-neko/neko/apps/openneko/internal/compose"
	"github.com/open-neko/neko/apps/openneko/internal/config"
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
		newBackupKeyCmd(),
	)
	return cmd
}

func newBackupKeyCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "key",
		Short: "Adopt or export the key bound to a backup repository",
	}
	cmd.AddCommand(newBackupKeyAdoptCmd(), newBackupKeyExportCmd())
	return cmd
}

func newBackupKeyAdoptCmd() *cobra.Command {
	var source string
	cmd := &cobra.Command{
		Use:   "adopt --from <key-file>",
		Short: "Validate and adopt an existing repository encryption key",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if source == "" {
				return fmt.Errorf("--from is required")
			}
			absolute, err := filepath.Abs(source)
			if err != nil {
				return err
			}
			repository, err := resolveBackupRepository()
			if err != nil {
				return err
			}
			value, err := config.ReadBackupKey(absolute)
			if err != nil {
				return err
			}
			identity, err := readBackupRepositoryIdentity(repository)
			if err == nil {
				if err := validateBackupRepositoryIdentity(*identity); err != nil {
					return err
				}
				if backupKeyFingerprint(value) != identity.KeyFingerprint {
					return fmt.Errorf("key %s does not match repository %s; neither was modified", absolute, repository)
				}
				keyPath, err := backupRepositoryKeyPath(identity.ID)
				if err != nil {
					return err
				}
				if err := persistBackupKey(keyPath, value); err != nil {
					return err
				}
				fmt.Fprintf(cmd.OutOrStdout(), "backup key already matches repository %s; durable copy: %s\n", repository, keyPath)
				return nil
			}
			if !errors.Is(err, fs.ErrNotExist) {
				return err
			}
			contents, err := classifyBackupRepository(repository)
			if err != nil {
				if errors.Is(err, fs.ErrPermission) {
					contents = repositoryBackupData
				} else {
					return err
				}
			}
			if contents == repositoryUnknownData {
				return fmt.Errorf("backup repository %s contains unrecognized data; refusing adoption", repository)
			}
			if contents == repositoryBackupData {
				if err := backupRepositoryKeyValidator(cmd.Context(), repository, absolute); err != nil {
					return fmt.Errorf("key adoption refused: %w", err)
				}
			}
			keyPath, err := adoptValidatedBackupRepositoryKey(repository, absolute)
			if err != nil {
				return err
			}
			fmt.Fprintf(cmd.OutOrStdout(), "adopted backup key for repository %s; durable copy: %s\n", repository, keyPath)
			return nil
		},
	}
	cmd.Flags().StringVar(&source, "from", "", "Original repository key file")
	return cmd
}

func newBackupKeyExportCmd() *cobra.Command {
	var destination string
	cmd := &cobra.Command{
		Use:   "export --to <key-file>",
		Short: "Export a recovery copy of the repository encryption key",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if destination == "" {
				return fmt.Errorf("--to is required")
			}
			repository, err := resolveBackupRepository()
			if err != nil {
				return err
			}
			identity, err := readBackupRepositoryIdentity(repository)
			if err != nil {
				if errors.Is(err, fs.ErrNotExist) {
					return fmt.Errorf("repository %s has no key identity; adopt its original key first", repository)
				}
				return err
			}
			keyPath, err := resolveIdentifiedRepositoryKey(repository, *identity)
			if err != nil {
				return err
			}
			value, err := config.ReadBackupKey(keyPath)
			if err != nil {
				return err
			}
			absolute, err := filepath.Abs(destination)
			if err != nil {
				return err
			}
			if err := config.WriteBackupKey(absolute, value); err != nil {
				if errors.Is(err, fs.ErrExist) {
					return fmt.Errorf("refusing to overwrite existing file %s", absolute)
				}
				return err
			}
			fmt.Fprintf(cmd.OutOrStdout(), "exported backup recovery key to %s; store it separately from the repository\n", absolute)
			return nil
		},
	}
	cmd.Flags().StringVar(&destination, "to", "", "New file to receive the key (must not already exist)")
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
