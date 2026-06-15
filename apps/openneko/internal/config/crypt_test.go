package config

import (
	"encoding/hex"
	"testing"
)

func TestOpenShellDBPasswordStableAndHex(t *testing.T) {
	dir := t.TempDir()

	a, err := OpenShellDBPassword(dir)
	if err != nil {
		t.Fatalf("derive: %v", err)
	}
	// Deterministic: same install (same secret-key) → same password, so every
	// `start` derives the value the role was provisioned with.
	b, err := OpenShellDBPassword(dir)
	if err != nil {
		t.Fatalf("derive again: %v", err)
	}
	if a != b {
		t.Fatalf("not deterministic: %q vs %q", a, b)
	}

	// Hex (no quotes/specials) so it's safe in a SQL literal and a URL.
	if len(a) != 64 {
		t.Fatalf("want 64 hex chars, got %d", len(a))
	}
	if _, err := hex.DecodeString(a); err != nil {
		t.Fatalf("not hex: %v", err)
	}
}

func TestOpenShellDBPasswordPerInstall(t *testing.T) {
	// Different secret-key (different install) → different password.
	a, err := OpenShellDBPassword(t.TempDir())
	if err != nil {
		t.Fatalf("derive a: %v", err)
	}
	b, err := OpenShellDBPassword(t.TempDir())
	if err != nil {
		t.Fatalf("derive b: %v", err)
	}
	if a == b {
		t.Fatal("two installs derived the same gateway password")
	}
}

func TestOpenShellDBPasswordIndependentOfNekoPassword(t *testing.T) {
	// Rotating the neko admin password must not change the derived gateway
	// password (it's keyed only off the secret-key).
	dir := t.TempDir()
	before, err := OpenShellDBPassword(dir)
	if err != nil {
		t.Fatalf("derive before: %v", err)
	}
	if err := WriteLocalPgPassword(dir, "a-rotated-neko-password"); err != nil {
		t.Fatalf("rotate: %v", err)
	}
	after, err := OpenShellDBPassword(dir)
	if err != nil {
		t.Fatalf("derive after: %v", err)
	}
	if before != after {
		t.Fatal("gateway password changed when the neko password rotated")
	}
}
