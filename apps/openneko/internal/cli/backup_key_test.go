package cli

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/open-neko/neko/apps/openneko/internal/config"
)

func TestBackupKeyAdoptValidatesLegacyRepository(t *testing.T) {
	_, dataHome, _ := configureBackupTestEnvironment(t)
	repository := defaultTestBackupRepository(t, dataHome)
	t.Setenv("OPENNEKO_BACKUP_REPOSITORY", repository)
	if err := os.MkdirAll(filepath.Join(repository, "backup", "openneko-metadata"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repository, "backup", "openneko-metadata", "backup.info"), []byte("encrypted"), 0o600); err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(t.TempDir(), "original.key")
	value := "original-repository-key-with-more-than-thirty-two-characters"
	if err := config.WriteBackupKey(source, value); err != nil {
		t.Fatal(err)
	}
	validated := false
	previous := backupRepositoryKeyValidator
	backupRepositoryKeyValidator = func(_ context.Context, gotRepository, gotKey string) error {
		validated = true
		if gotRepository != repository || gotKey != source {
			t.Fatalf("validator got repository=%q key=%q", gotRepository, gotKey)
		}
		return nil
	}
	t.Cleanup(func() { backupRepositoryKeyValidator = previous })

	var output bytes.Buffer
	cmd := newBackupKeyAdoptCmd()
	cmd.SetOut(&output)
	cmd.SetArgs([]string{"--from", source})
	if err := cmd.ExecuteContext(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !validated {
		t.Fatal("legacy repository key was not validated")
	}
	if !strings.Contains(output.String(), "adopted backup key") {
		t.Fatalf("adopt output = %q", output.String())
	}
	identity, err := readBackupRepositoryIdentity(repository)
	if err != nil {
		t.Fatal(err)
	}
	keyPath, err := backupRepositoryKeyPath(identity.ID)
	if err != nil {
		t.Fatal(err)
	}
	got, err := config.ReadBackupKey(keyPath)
	if err != nil {
		t.Fatal(err)
	}
	if got != value {
		t.Fatal("adopted durable key differs from source")
	}
}

func TestBackupKeyExportNeverOverwrites(t *testing.T) {
	_, _, _ = configureBackupTestEnvironment(t)
	if err := configureBackupEnvironment("openneko-demo"); err != nil {
		t.Fatal(err)
	}
	destination := filepath.Join(t.TempDir(), "recovery", "backup.key")
	cmd := newBackupKeyExportCmd()
	cmd.SetArgs([]string{"--to", destination})
	if err := cmd.ExecuteContext(context.Background()); err != nil {
		t.Fatal(err)
	}
	first, err := config.ReadBackupKey(destination)
	if err != nil {
		t.Fatal(err)
	}
	cmd = newBackupKeyExportCmd()
	cmd.SetArgs([]string{"--to", destination})
	if err := cmd.ExecuteContext(context.Background()); err == nil {
		t.Fatal("expected export to refuse an existing destination")
	}
	second, err := config.ReadBackupKey(destination)
	if err != nil {
		t.Fatal(err)
	}
	if first != second {
		t.Fatal("existing exported key was overwritten")
	}
}
