package cli

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/open-neko/neko/apps/openneko/assets"
	"github.com/open-neko/neko/apps/openneko/internal/compose"
	"github.com/open-neko/neko/apps/openneko/internal/config"
	"github.com/open-neko/neko/apps/openneko/internal/instance"
)

func configureBackupTestEnvironment(t *testing.T) (string, string, string) {
	t.Helper()
	root := t.TempDir()
	configHome := filepath.Join(root, "config")
	dataHome := filepath.Join(root, "data")
	stateHome := filepath.Join(root, "state")
	t.Setenv("XDG_CONFIG_HOME", configHome)
	t.Setenv("XDG_DATA_HOME", dataHome)
	t.Setenv("XDG_STATE_HOME", stateHome)
	t.Setenv("OPENNEKO_WORKSPACE_ROOT", root)
	t.Setenv("OPENNEKO_BACKUP_CIPHER_PASS", "")
	t.Setenv("OPENNEKO_BACKUP_KEY_FILE", "")
	t.Setenv("OPENNEKO_BACKUP_KEY_DIR", "")
	t.Setenv("OPENNEKO_BACKUP_STATE_DIR", "")
	t.Setenv("OPENNEKO_BACKUP_REPOSITORY", "")
	t.Setenv("OPENNEKO_HOST_CONFIG_DIR", "")
	return configHome, dataHome, stateHome
}

func defaultTestBackupRepository(t *testing.T, dataHome string) string {
	t.Helper()
	installationID, err := compose.New(assets.ComposeFS).InstallationID()
	if err != nil {
		t.Fatal(err)
	}
	return filepath.Join(dataHome, "openneko", "repositories", installationID, "openneko-demo")
}

func testBackupRepositoryIdentityFile(t *testing.T, repository string) string {
	t.Helper()
	path, err := backupRepositoryIdentityFile(repository)
	if err != nil {
		t.Fatal(err)
	}
	return path
}

func TestConfigureBackupEnvironmentCreatesRepositoryBoundExternalKey(t *testing.T) {
	configHome, dataHome, stateHome := configureBackupTestEnvironment(t)

	if err := configureBackupEnvironment("openneko-demo"); err != nil {
		t.Fatal(err)
	}
	wantRepository := defaultTestBackupRepository(t, dataHome)
	if got := os.Getenv("OPENNEKO_BACKUP_REPOSITORY"); got != wantRepository {
		t.Fatalf("backup repository = %q, want %q", got, wantRepository)
	}
	keyPath := os.Getenv("OPENNEKO_BACKUP_KEY_FILE")
	if filepath.Dir(keyPath) != filepath.Join(stateHome, "openneko", "backup-keys") {
		t.Fatalf("backup key path = %q, want repository key state dir", keyPath)
	}
	if _, err := config.ReadBackupKey(keyPath); err != nil {
		t.Fatal(err)
	}
	if os.Getenv("OPENNEKO_BACKUP_CIPHER_PASS") != "" {
		t.Fatal("backup key remained in the host process environment")
	}
	identityPath := testBackupRepositoryIdentityFile(t, wantRepository)
	if strings.HasPrefix(identityPath, wantRepository+string(filepath.Separator)) {
		t.Fatal("repository identity must remain outside the Docker bind mount")
	}
	identityInfo, err := os.Stat(identityPath)
	if err != nil {
		t.Fatal(err)
	}
	if identityInfo.Mode().Perm() != 0o600 {
		t.Fatalf("repository identity mode = %o, want 600", identityInfo.Mode().Perm())
	}
	if got := os.Getenv("OPENNEKO_HOST_CONFIG_DIR"); got != filepath.Join(configHome, "openneko") {
		t.Fatalf("host config snapshot path = %q", got)
	}
}

func TestNamedBackupEnvironmentOverridesGlobalHostConfigPath(t *testing.T) {
	configHome, _, _ := configureBackupTestEnvironment(t)
	t.Setenv(instance.EnvName, "acme")
	t.Setenv("OPENNEKO_HOST_CONFIG_DIR", filepath.Join(t.TempDir(), "another-customer"))
	if err := configureBackupEnvironment("openneko-acme-prod"); err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(configHome, "openneko", "instances", "acme")
	if got := os.Getenv("OPENNEKO_HOST_CONFIG_DIR"); got != want {
		t.Fatalf("host config dir = %q, want %q", got, want)
	}
}

func TestIdentifiedRepositoryDoesNotRequireHostTraversal(t *testing.T) {
	_, _, _ = configureBackupTestEnvironment(t)
	if err := configureBackupEnvironment("openneko-demo"); err != nil {
		t.Fatal(err)
	}
	repository := os.Getenv("OPENNEKO_BACKUP_REPOSITORY")
	keyPath := os.Getenv("OPENNEKO_BACKUP_KEY_FILE")
	if err := os.Chmod(repository, 0o000); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(repository, 0o700) })
	t.Setenv("OPENNEKO_BACKUP_KEY_FILE", "")
	if err := configureBackupEnvironment("openneko-demo"); err != nil {
		t.Fatal(err)
	}
	if got := os.Getenv("OPENNEKO_BACKUP_KEY_FILE"); got != keyPath {
		t.Fatalf("key path changed after repository ownership change: got %q want %q", got, keyPath)
	}
}

func TestRepositoryKeySurvivesDifferentConfigHome(t *testing.T) {
	_, _, _ = configureBackupTestEnvironment(t)
	if err := configureBackupEnvironment("openneko-demo"); err != nil {
		t.Fatal(err)
	}
	firstPath := os.Getenv("OPENNEKO_BACKUP_KEY_FILE")
	firstValue, err := config.ReadBackupKey(firstPath)
	if err != nil {
		t.Fatal(err)
	}

	t.Setenv("XDG_CONFIG_HOME", filepath.Join(t.TempDir(), "reinstalled-config"))
	t.Setenv("OPENNEKO_BACKUP_KEY_FILE", "")
	t.Setenv("OPENNEKO_HOST_CONFIG_DIR", "")
	if err := configureBackupEnvironment("openneko-demo"); err != nil {
		t.Fatal(err)
	}
	secondPath := os.Getenv("OPENNEKO_BACKUP_KEY_FILE")
	secondValue, err := config.ReadBackupKey(secondPath)
	if err != nil {
		t.Fatal(err)
	}
	if secondPath != firstPath || secondValue != firstValue {
		t.Fatal("reinstall selected a different repository encryption key")
	}
}

func TestSameModeInDifferentWorkspacesUsesDifferentRepository(t *testing.T) {
	_, _, _ = configureBackupTestEnvironment(t)
	if err := configureBackupEnvironment("openneko-demo"); err != nil {
		t.Fatal(err)
	}
	firstRepository := os.Getenv("OPENNEKO_BACKUP_REPOSITORY")
	firstKey := os.Getenv("OPENNEKO_BACKUP_KEY_FILE")

	t.Setenv("OPENNEKO_WORKSPACE_ROOT", t.TempDir())
	t.Setenv("OPENNEKO_BACKUP_REPOSITORY", "")
	t.Setenv("OPENNEKO_BACKUP_KEY_FILE", "")
	if err := configureBackupEnvironment("openneko-demo"); err != nil {
		t.Fatal(err)
	}
	if secondRepository := os.Getenv("OPENNEKO_BACKUP_REPOSITORY"); secondRepository == firstRepository {
		t.Fatal("separate demo installations shared a backup repository")
	}
	if secondKey := os.Getenv("OPENNEKO_BACKUP_KEY_FILE"); secondKey == firstKey {
		t.Fatal("separate repositories shared a backup key")
	}
}

func TestIdentifiedRepositoryRejectsMismatchedExplicitKey(t *testing.T) {
	_, _, _ = configureBackupTestEnvironment(t)
	if err := configureBackupEnvironment("openneko-demo"); err != nil {
		t.Fatal(err)
	}
	repository := os.Getenv("OPENNEKO_BACKUP_REPOSITORY")
	before, err := os.ReadFile(testBackupRepositoryIdentityFile(t, repository))
	if err != nil {
		t.Fatal(err)
	}
	wrong := filepath.Join(t.TempDir(), "wrong.key")
	if err := config.WriteBackupKey(wrong, "wrong-key-with-more-than-thirty-two-characters"); err != nil {
		t.Fatal(err)
	}
	t.Setenv("OPENNEKO_BACKUP_KEY_FILE", wrong)
	if err := configureBackupEnvironment("openneko-demo"); err == nil {
		t.Fatal("expected mismatched key to be rejected")
	}
	after, err := os.ReadFile(testBackupRepositoryIdentityFile(t, repository))
	if err != nil {
		t.Fatal(err)
	}
	if string(after) != string(before) {
		t.Fatal("repository identity changed after a key mismatch")
	}
}

func TestLegacyRepositoryAutomaticallyAdoptsValidatedConfigKey(t *testing.T) {
	configHome, dataHome, stateHome := configureBackupTestEnvironment(t)
	repository := defaultTestBackupRepository(t, dataHome)
	if err := os.MkdirAll(filepath.Join(repository, "backup", "openneko-metadata"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repository, "backup", "openneko-metadata", "backup.info"), []byte("encrypted"), 0o600); err != nil {
		t.Fatal(err)
	}
	legacy := filepath.Join(configHome, "openneko", "backup-key")
	if err := config.WriteBackupKey(legacy, "legacy-key-with-more-than-thirty-two-characters"); err != nil {
		t.Fatal(err)
	}
	previous := backupRepositoryKeyValidator
	backupRepositoryKeyValidator = func(_ context.Context, gotRepository, gotKey string) error {
		if gotRepository != repository || gotKey != legacy {
			t.Fatalf("validator got repository=%q key=%q", gotRepository, gotKey)
		}
		return nil
	}
	t.Cleanup(func() { backupRepositoryKeyValidator = previous })

	if err := configureBackupEnvironment("openneko-demo"); err != nil {
		t.Fatal(err)
	}
	keyPath := os.Getenv("OPENNEKO_BACKUP_KEY_FILE")
	if filepath.Dir(keyPath) != filepath.Join(stateHome, "openneko", "backup-keys") {
		t.Fatalf("migrated key path = %q", keyPath)
	}
	if _, err := os.Stat(testBackupRepositoryIdentityFile(t, repository)); err != nil {
		t.Fatal(err)
	}
}

func TestLegacyRepositoryMismatchFailsWithoutMutation(t *testing.T) {
	configHome, dataHome, stateHome := configureBackupTestEnvironment(t)
	repository := defaultTestBackupRepository(t, dataHome)
	if err := os.MkdirAll(filepath.Join(repository, "archive", "openneko-metadata"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repository, "archive", "openneko-metadata", "archive.info"), []byte("encrypted"), 0o600); err != nil {
		t.Fatal(err)
	}
	legacy := filepath.Join(configHome, "openneko", "backup-key")
	if err := config.WriteBackupKey(legacy, "mismatched-key-with-more-than-thirty-two-characters"); err != nil {
		t.Fatal(err)
	}
	previous := backupRepositoryKeyValidator
	backupRepositoryKeyValidator = func(context.Context, string, string) error { return errors.New("cipher mismatch") }
	t.Cleanup(func() { backupRepositoryKeyValidator = previous })

	if err := configureBackupEnvironment("openneko-demo"); err == nil {
		t.Fatal("expected legacy mismatch to fail")
	}
	if _, err := os.Stat(testBackupRepositoryIdentityFile(t, repository)); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("repository identity unexpectedly created: %v", err)
	}
	entries, err := os.ReadDir(filepath.Join(stateHome, "openneko", "backup-keys"))
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatal("durable key was created for a rejected repository")
	}
}

func TestConfigureBackupEnvironmentPreservesRepositoryOverride(t *testing.T) {
	_, _, _ = configureBackupTestEnvironment(t)
	repository := filepath.Join(t.TempDir(), "custom-backups")
	t.Setenv("OPENNEKO_BACKUP_REPOSITORY", repository)
	if err := configureBackupEnvironment("openneko-demo"); err != nil {
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
