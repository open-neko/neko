package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestWriteLocalPgPasswordRoundTrip(t *testing.T) {
	dir := t.TempDir()

	if err := WriteLocalPgPassword(dir, "DemoPass2026!"); err != nil {
		t.Fatalf("write: %v", err)
	}

	// On disk the password must be encrypted at rest (enc:v1), not plaintext.
	raw, err := os.ReadFile(filepath.Join(dir, "config.json"))
	if err != nil {
		t.Fatalf("read file: %v", err)
	}
	var onDisk Local
	if err := json.Unmarshal(raw, &onDisk); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if onDisk.Pg == nil || !IsEncrypted(onDisk.Pg.Password) {
		t.Fatalf("password should be enc:v1 on disk, got %q", onDisk.Pg.Password)
	}

	// ReadLocal decrypts it back to the plaintext every host reader expects.
	lc, path := ReadLocal(dir)
	if path == "" {
		t.Fatal("ReadLocal found no file")
	}
	if lc.Pg == nil || lc.Pg.Password != "DemoPass2026!" {
		t.Fatalf("round-trip mismatch: %+v", lc.Pg)
	}
}

func TestWriteLocalPgPasswordPreservesFields(t *testing.T) {
	dir := t.TempDir()

	// Seed an existing config with non-password pg fields.
	seed, _ := json.Marshal(Local{Pg: &LocalPg{User: "neko", Database: "neko", Port: 5432}})
	if err := os.WriteFile(filepath.Join(dir, "config.json"), seed, 0o600); err != nil {
		t.Fatalf("seed: %v", err)
	}

	if err := WriteLocalPgPassword(dir, "rotated-pass"); err != nil {
		t.Fatalf("write: %v", err)
	}

	lc, _ := ReadLocal(dir)
	if lc.Pg == nil {
		t.Fatal("pg block lost")
	}
	if lc.Pg.User != "neko" || lc.Pg.Database != "neko" || lc.Pg.Port != 5432 {
		t.Fatalf("non-password fields not preserved: %+v", lc.Pg)
	}
	if lc.Pg.Password != "rotated-pass" {
		t.Fatalf("password not written: %q", lc.Pg.Password)
	}
}

func TestWriteLocalDatabasePasswordsRoundTrip(t *testing.T) {
	dir := t.TempDir()
	if err := WriteLocalDatabasePasswords(dir, "metadata-pass", "records-pass"); err != nil {
		t.Fatalf("write both: %v", err)
	}

	raw, err := os.ReadFile(filepath.Join(dir, "config.json"))
	if err != nil {
		t.Fatalf("read file: %v", err)
	}
	var onDisk Local
	if err := json.Unmarshal(raw, &onDisk); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if onDisk.Pg == nil || !IsEncrypted(onDisk.Pg.Password) {
		t.Fatal("metadata password is not encrypted")
	}
	if onDisk.RecordsPg == nil || !IsEncrypted(onDisk.RecordsPg.Password) {
		t.Fatal("records password is not encrypted")
	}

	lc, _ := ReadLocal(dir)
	if lc.Pg == nil || lc.Pg.Password != "metadata-pass" {
		t.Fatalf("metadata round-trip mismatch: %+v", lc.Pg)
	}
	if lc.RecordsPg == nil || lc.RecordsPg.Password != "records-pass" {
		t.Fatalf("records round-trip mismatch: %+v", lc.RecordsPg)
	}
}
