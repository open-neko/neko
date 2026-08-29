package cli

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestEnvTruthy(t *testing.T) {
	for _, value := range []string{"1", "true", "TRUE", "yes", "on", " on "} {
		t.Setenv("OPENNEKO_TEST_TRUTHY", value)
		if !envTruthy("OPENNEKO_TEST_TRUTHY") {
			t.Fatalf("%q should be true", value)
		}
	}
	for _, value := range []string{"", "0", "false", "no", "off", "garbage"} {
		t.Setenv("OPENNEKO_TEST_TRUTHY", value)
		if envTruthy("OPENNEKO_TEST_TRUTHY") {
			t.Fatalf("%q should be false", value)
		}
	}
}

func TestOpenShellDBPasswordEnvironmentOverride(t *testing.T) {
	t.Setenv(openShellDBPasswordEnv, "container-provided-password")
	t.Setenv(requireExplicitOpenShellDBPasswordEnv, "1")
	got, err := openShellDBPassword()
	if err != nil {
		t.Fatal(err)
	}
	if got != "container-provided-password" {
		t.Fatalf("password = %q", got)
	}
}

func TestOpenShellDBPasswordManagedMigrationFailsClosed(t *testing.T) {
	configHome := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", configHome)
	t.Setenv(openShellDBPasswordEnv, "")
	t.Setenv(requireExplicitOpenShellDBPasswordEnv, "1")

	_, err := openShellDBPassword()
	if err == nil || !strings.Contains(err.Error(), openShellDBPasswordEnv) ||
		!strings.Contains(err.Error(), "refusing") {
		t.Fatalf("error = %v, want fail-closed missing-credential error", err)
	}
	if _, statErr := os.Stat(filepath.Join(configHome, "openneko", "secret-key")); !os.IsNotExist(statErr) {
		t.Fatalf("managed migration derived a container-local secret-key: %v", statErr)
	}
}
