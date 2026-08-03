package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestBackupCipherPasswordIsStableAndPrivate(t *testing.T) {
	dir := t.TempDir()
	first, err := BackupCipherPassword(dir)
	if err != nil {
		t.Fatal(err)
	}
	second, err := BackupCipherPassword(dir)
	if err != nil {
		t.Fatal(err)
	}
	if first != second || len(first) != 64 {
		t.Fatalf("backup key was not a stable 256-bit hex value")
	}
	info, err := os.Stat(filepath.Join(dir, backupKeyFilename))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("backup key mode = %o, want 600", info.Mode().Perm())
	}
}

func TestBackupCipherPasswordRejectsShortExistingKey(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, backupKeyFilename), []byte("short\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := BackupCipherPassword(dir); err == nil {
		t.Fatal("expected a short backup key to be rejected")
	}
}
