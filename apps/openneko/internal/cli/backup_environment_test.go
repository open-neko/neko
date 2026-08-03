package cli

import (
	"os"
	"path/filepath"
	"testing"
)

func TestConfigureBackupEnvironmentCreatesStableExternalState(t *testing.T) {
	configHome := filepath.Join(t.TempDir(), "config")
	dataHome := filepath.Join(t.TempDir(), "data")
	t.Setenv("XDG_CONFIG_HOME", configHome)
	t.Setenv("XDG_DATA_HOME", dataHome)
	t.Setenv("OPENNEKO_BACKUP_CIPHER_PASS", "")
	t.Setenv("OPENNEKO_BACKUP_REPOSITORY", "")
	t.Setenv("OPENNEKO_HOST_CONFIG_DIR", "")

	if err := configureBackupEnvironment(); err != nil {
		t.Fatal(err)
	}
	password := os.Getenv("OPENNEKO_BACKUP_CIPHER_PASS")
	if len(password) != 64 {
		t.Fatalf("backup cipher password length = %d, want 64", len(password))
	}
	wantRepository := filepath.Join(dataHome, "openneko", "backups")
	if got := os.Getenv("OPENNEKO_BACKUP_REPOSITORY"); got != wantRepository {
		t.Fatalf("backup repository = %q, want %q", got, wantRepository)
	}
	if _, err := os.Stat(wantRepository); err != nil {
		t.Fatal(err)
	}
	if got := os.Getenv("OPENNEKO_HOST_CONFIG_DIR"); got != filepath.Join(configHome, "openneko") {
		t.Fatalf("host config snapshot path = %q", got)
	}
}

func TestConfigureBackupEnvironmentPreservesOverrides(t *testing.T) {
	repository := filepath.Join(t.TempDir(), "custom-backups")
	t.Setenv("OPENNEKO_BACKUP_CIPHER_PASS", "operator-key-with-more-than-thirty-two-characters")
	t.Setenv("OPENNEKO_BACKUP_REPOSITORY", repository)
	if err := configureBackupEnvironment(); err != nil {
		t.Fatal(err)
	}
	if got := os.Getenv("OPENNEKO_BACKUP_REPOSITORY"); got != repository {
		t.Fatalf("repository override changed to %q", got)
	}
}

func TestBackupFailureDomainWarningRequiresExplicitAcknowledgement(t *testing.T) {
	t.Setenv("OPENNEKO_BACKUP_REPOSITORY", "/mnt/openneko-backups")
	t.Setenv("OPENNEKO_BACKUP_FAILURE_DOMAIN_ACK", "")
	if backupFailureDomainWarning() == "" {
		t.Fatal("expected an unacknowledged host path warning")
	}
	t.Setenv("OPENNEKO_BACKUP_FAILURE_DOMAIN_ACK", "1")
	if warning := backupFailureDomainWarning(); warning != "" {
		t.Fatalf("acknowledged repository warning = %q", warning)
	}
}
