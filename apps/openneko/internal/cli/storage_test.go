package cli

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/open-neko/neko/apps/openneko/internal/db"
)

func TestStorageContractCommandReportsCompiledContract(t *testing.T) {
	cmd := newStorageCmd()
	var output bytes.Buffer
	cmd.SetOut(&output)
	cmd.SetErr(&output)
	cmd.SetArgs([]string{"contract"})
	if err := cmd.Execute(); err != nil {
		t.Fatal(err)
	}
	if got, want := strings.TrimSpace(output.String()), "1"; got != want {
		t.Fatalf("storage contract = %q, want %q", got, want)
	}
	if db.StorageContractVersion != 1 {
		t.Fatalf("update the database image label and this test for storage contract %d", db.StorageContractVersion)
	}
}

func TestRecordsConnUsesLocalConfigOverEnvironment(t *testing.T) {
	configHome := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", configHome)
	t.Setenv("RECORDS_PG_HOST", "records-env")
	t.Setenv("RECORDS_PG_PORT", "6000")
	t.Setenv("RECORDS_PG_USER", "records-env-user")
	t.Setenv("RECORDS_PG_PASSWORD", "records-env-password")
	t.Setenv("RECORDS_PG_DATABASE", "records-env-db")
	t.Setenv("RECORDS_PG_SSLMODE", "disable")

	localDir := filepath.Join(configHome, "openneko")
	if err := os.MkdirAll(localDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(localDir, "config.json"), []byte(`{
  "recordsPg": {
    "host": "records-local",
    "port": 6001,
    "user": "records-local-user",
    "password": "records-local-password",
    "database": "records-local-db",
    "sslmode": "require"
  }
}`), 0o600); err != nil {
		t.Fatal(err)
	}

	got := recordsConn()
	if got.Host != "records-local" || got.Port != 6001 || got.User != "records-local-user" ||
		got.Password != "records-local-password" || got.Database != "records-local-db" || got.SSLMode != "require" {
		t.Fatalf("recordsConn() = %+v", got)
	}
}
