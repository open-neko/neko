package cli

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/open-neko/neko/apps/openneko/internal/config"
)

// configureBackupEnvironment supplies compose with a stable host-only key and
// an absolute repository path. Neither is stored in a volume captured by the
// backup set, which preserves recoverability after a whole-stack loss.
func configureBackupEnvironment() error {
	if os.Getenv("OPENNEKO_BACKUP_CIPHER_PASS") == "" {
		password, err := config.BackupCipherPassword("")
		if err != nil {
			return err
		}
		if err := os.Setenv("OPENNEKO_BACKUP_CIPHER_PASS", password); err != nil {
			return err
		}
	}
	if os.Getenv("OPENNEKO_HOST_CONFIG_DIR") == "" {
		hostConfig, err := filepath.Abs(config.Dir(""))
		if err != nil {
			return err
		}
		if err := os.MkdirAll(hostConfig, 0o700); err != nil {
			return err
		}
		if err := os.Setenv("OPENNEKO_HOST_CONFIG_DIR", hostConfig); err != nil {
			return err
		}
	}

	repository := os.Getenv("OPENNEKO_BACKUP_REPOSITORY")
	if repository == "" {
		base := os.Getenv("XDG_DATA_HOME")
		if base == "" {
			home, err := os.UserHomeDir()
			if err != nil {
				return err
			}
			base = filepath.Join(home, ".local", "share")
		}
		repository = filepath.Join(base, "openneko", "backups")
	}
	absolute, err := filepath.Abs(repository)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(absolute, 0o700); err != nil {
		return err
	}
	return os.Setenv("OPENNEKO_BACKUP_REPOSITORY", absolute)
}

func backupFailureDomainWarning() string {
	if os.Getenv("OPENNEKO_BACKUP_FAILURE_DOMAIN_ACK") == "1" {
		return ""
	}
	return fmt.Sprintf(
		"backup repository %s is a host path; mount it from a NAS or other failure domain, then set OPENNEKO_BACKUP_FAILURE_DOMAIN_ACK=1",
		os.Getenv("OPENNEKO_BACKUP_REPOSITORY"),
	)
}
