package installation

import (
	"os"
	"path/filepath"
	"testing"
)

func sampleSettings() Settings {
	return Settings{
		Version:        CurrentVersion,
		Instance:       "acme",
		Mode:           "prod",
		WebPort:        3100,
		WebBindAddress: "127.0.0.1",
		OpenShellPort:  18100,
		DockerSubnet:   "10.224.1.0/24",
	}
}

func TestSettingsRoundTrip(t *testing.T) {
	dir := t.TempDir()
	want := sampleSettings()
	if err := Save(dir, want); err != nil {
		t.Fatal(err)
	}
	got, ok, err := Load(dir)
	if err != nil || !ok {
		t.Fatalf("Load = %+v, %v, %v", got, ok, err)
	}
	if got != want {
		t.Fatalf("got %+v, want %+v", got, want)
	}
	info, err := os.Stat(filepath.Join(dir, Filename))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("settings mode = %v", info.Mode().Perm())
	}
}

func TestSettingsValidation(t *testing.T) {
	settings := sampleSettings()
	settings.WebPort = settings.OpenShellPort
	if err := settings.Validate(); err == nil {
		t.Fatal("expected duplicate port error")
	}
	settings = sampleSettings()
	settings.DockerSubnet = "10.224.1.1/24"
	if err := settings.Validate(); err == nil {
		t.Fatal("expected non-canonical subnet error")
	}
	settings = sampleSettings()
	settings.DockerSubnet = ""
	if err := settings.Validate(); err == nil {
		t.Fatal("expected named-instance subnet error")
	}
}

func TestApplyEnvironmentPreservesExplicitOverrides(t *testing.T) {
	t.Setenv("OPENNEKO_PORT", "3999")
	t.Setenv("OPENSHELL_PORT", "")
	if err := ApplyEnvironment(sampleSettings(), false); err != nil {
		t.Fatal(err)
	}
	if got := os.Getenv("OPENNEKO_PORT"); got != "3999" {
		t.Fatalf("explicit web port replaced with %q", got)
	}
	if got := os.Getenv("OPENSHELL_PORT"); got != "18100" {
		t.Fatalf("persisted OpenShell port not applied: %q", got)
	}
}
