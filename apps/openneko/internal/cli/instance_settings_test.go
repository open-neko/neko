package cli

import (
	"context"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/open-neko/neko/apps/openneko/internal/config"
	"github.com/open-neko/neko/apps/openneko/internal/installation"
	"github.com/open-neko/neko/apps/openneko/internal/instance"
)

func isolateNamedInstallation(t *testing.T, name string) {
	t.Helper()
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Setenv("XDG_STATE_HOME", t.TempDir())
	t.Setenv("OPENNEKO_WORKSPACE_ROOT", "")
	t.Setenv("OPENNEKO_PORT", "")
	t.Setenv("OPENNEKO_WEB_BIND_ADDRESS", "")
	t.Setenv("OPENSHELL_PORT", "")
	t.Setenv(openShellNetworkSubnetEnv, "")
	t.Setenv(openShellNetworkGatewayEnv, "")
	t.Setenv(openShellNetworkIPRangeEnv, "")
	t.Setenv(openShellGatewayIPEnv, "")
	t.Setenv(instance.EnvName, name)
}

func TestPrepareSetupInstallationPersistsExplicitInstanceSettings(t *testing.T) {
	isolateNamedInstallation(t, "acme")
	cmd := newSetupCmd()
	for name, value := range map[string]string{
		"mode":           "prod",
		"port":           "3100",
		"openshell-port": "18100",
		"bind-address":   "127.0.0.1",
		"docker-subnet":  "10.224.10.0/24",
	} {
		if err := cmd.Flags().Set(name, value); err != nil {
			t.Fatal(err)
		}
	}
	settings, err := prepareSetupInstallation(context.Background(), cmd, "prod", setupHostOptions{
		webPort:             3100,
		webPortChanged:      true,
		openShellPort:       18100,
		openShellChanged:    true,
		webBindAddress:      "127.0.0.1",
		webBindChanged:      true,
		dockerSubnet:        "10.224.10.0/24",
		dockerSubnetChanged: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if settings.Instance != "acme" || settings.WebPort != 3100 || settings.OpenShellPort != 18100 {
		t.Fatalf("settings = %+v", settings)
	}
	readBack, ok, err := installation.Load(config.Dir(""))
	if err != nil || !ok || readBack != settings {
		t.Fatalf("readBack = %+v, ok=%v, err=%v", readBack, ok, err)
	}
	if got := os.Getenv("OPENNEKO_PORT"); got != "3100" {
		t.Fatalf("OPENNEKO_PORT = %q", got)
	}
}

func TestActivateInstallationRestoresPersistedPorts(t *testing.T) {
	isolateNamedInstallation(t, "acme")
	settings := installation.Settings{
		Version:        installation.CurrentVersion,
		Instance:       "acme",
		Mode:           "prod",
		WebPort:        3200,
		WebBindAddress: "127.0.0.1",
		OpenShellPort:  18200,
		DockerSubnet:   "10.224.20.0/24",
	}
	if err := installation.Save(config.Dir(""), settings); err != nil {
		t.Fatal(err)
	}
	t.Setenv(instance.EnvName, "")
	t.Setenv("OPENNEKO_PORT", "")
	t.Setenv("OPENSHELL_PORT", "")
	if err := activateInstallation("acme"); err != nil {
		t.Fatal(err)
	}
	if os.Getenv("OPENNEKO_PORT") != "3200" || os.Getenv("OPENSHELL_PORT") != "18200" {
		t.Fatalf("persisted ports not restored: web=%q openshell=%q", os.Getenv("OPENNEKO_PORT"), os.Getenv("OPENSHELL_PORT"))
	}
}

func TestActivateNamedInstallationDoesNotInheritAnotherStacksPorts(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Setenv(instance.EnvName, "acme")
	settings := installation.Settings{
		Version:        installation.CurrentVersion,
		Instance:       "acme",
		Mode:           "prod",
		WebPort:        3100,
		WebBindAddress: "127.0.0.1",
		OpenShellPort:  18100,
		DockerSubnet:   "10.224.10.0/24",
	}
	if err := installation.Save(config.Dir(""), settings); err != nil {
		t.Fatal(err)
	}
	t.Setenv("OPENNEKO_PORT", "3999")
	t.Setenv("OPENSHELL_PORT", "19999")
	t.Setenv(openShellNetworkGatewayEnv, "10.225.1.1")
	t.Setenv(openShellNetworkIPRangeEnv, "10.225.1.128/25")
	t.Setenv(openShellGatewayIPEnv, "10.225.1.2")
	if err := activateInstallation("acme"); err != nil {
		t.Fatal(err)
	}
	if got := os.Getenv("OPENNEKO_PORT"); got != "3100" {
		t.Fatalf("web port = %q, want persisted 3100", got)
	}
	if got := os.Getenv("OPENSHELL_PORT"); got != "18100" {
		t.Fatalf("OpenShell port = %q, want persisted 18100", got)
	}
	for _, key := range []string{openShellNetworkGatewayEnv, openShellNetworkIPRangeEnv, openShellGatewayIPEnv} {
		if got := os.Getenv(key); got != "" {
			t.Fatalf("derived network override %s was retained as %q", key, got)
		}
	}
}

func TestModeForStartRequiresNamedSetup(t *testing.T) {
	isolateNamedInstallation(t, "not-installed")
	cmd := newStartCmd()
	_, err := modeForStart(cmd, "prod")
	if err == nil || !strings.Contains(err.Error(), "openneko setup --instance not-installed") {
		t.Fatalf("error = %v", err)
	}
}

func TestModeForStartUsesPersistedMode(t *testing.T) {
	isolateNamedInstallation(t, "demo-customer")
	settings := installation.Settings{
		Version:        installation.CurrentVersion,
		Instance:       "demo-customer",
		Mode:           "demo",
		WebPort:        3300,
		WebBindAddress: "127.0.0.1",
		OpenShellPort:  18300,
		DockerSubnet:   "10.224.30.0/24",
	}
	if err := installation.Save(config.Dir(""), settings); err != nil {
		t.Fatal(err)
	}
	cmd := newStartCmd()
	mode, err := modeForStart(cmd, "prod")
	if err != nil || string(mode) != "demo" {
		t.Fatalf("mode=%q err=%v", mode, err)
	}
}

func TestPrefixOverlap(t *testing.T) {
	occupied := mustPrefixes(t, "10.224.20.0/24", "172.17.0.0/16")
	if !prefixOverlapsAny(mustPrefixes(t, "10.224.20.0/24")[0], occupied) {
		t.Fatal("exact overlap not detected")
	}
	if prefixOverlapsAny(mustPrefixes(t, "10.225.20.0/24")[0], occupied) {
		t.Fatal("unrelated subnet reported as overlap")
	}
}

func TestAllocateInstanceSubnetIsStableAndSkipsPersistedReservation(t *testing.T) {
	isolateNamedInstallation(t, "globex")
	previous := listDockerNetworkSubnets
	t.Cleanup(func() { listDockerNetworkSubnets = previous })
	listDockerNetworkSubnets = func(context.Context) ([]netip.Prefix, error) { return nil, nil }

	first, err := allocateInstanceSubnet(context.Background(), "stable-seed")
	if err != nil {
		t.Fatal(err)
	}
	acme := installation.Settings{
		Version:        1,
		Instance:       "acme",
		Mode:           "prod",
		WebPort:        3100,
		WebBindAddress: "127.0.0.1",
		OpenShellPort:  18100,
		DockerSubnet:   first,
	}
	if err := installation.Save(filepath.Join(config.RootDir(), "instances", "acme"), acme); err != nil {
		t.Fatal(err)
	}
	second, err := allocateInstanceSubnet(context.Background(), "stable-seed")
	if err != nil {
		t.Fatal(err)
	}
	if first == second {
		t.Fatalf("allocator reused persisted subnet %s", first)
	}
}

func TestSetupRejectsPortReservedByStoppedInstance(t *testing.T) {
	isolateNamedInstallation(t, "globex")
	acme := installation.Settings{
		Version:        1,
		Instance:       "acme",
		Mode:           "prod",
		WebPort:        3100,
		WebBindAddress: "127.0.0.1",
		OpenShellPort:  18100,
		DockerSubnet:   "10.224.10.0/24",
	}
	if err := installation.Save(filepath.Join(config.RootDir(), "instances", "acme"), acme); err != nil {
		t.Fatal(err)
	}
	cmd := newSetupCmd()
	if err := cmd.Flags().Set("port", "3100"); err != nil {
		t.Fatal(err)
	}
	if err := cmd.Flags().Set("openshell-port", "18101"); err != nil {
		t.Fatal(err)
	}
	if err := cmd.Flags().Set("bind-address", "127.0.0.1"); err != nil {
		t.Fatal(err)
	}
	if err := cmd.Flags().Set("docker-subnet", "10.224.11.0/24"); err != nil {
		t.Fatal(err)
	}
	_, err := prepareSetupInstallation(context.Background(), cmd, "prod", setupHostOptions{
		webPort:             3100,
		webPortChanged:      true,
		openShellPort:       18101,
		openShellChanged:    true,
		webBindAddress:      "127.0.0.1",
		webBindChanged:      true,
		dockerSubnet:        "10.224.11.0/24",
		dockerSubnetChanged: true,
	})
	if err == nil || !strings.Contains(err.Error(), "reserved by instance acme") {
		t.Fatalf("error = %v", err)
	}
}

func TestSetupRejectsSubnetReservedByStoppedInstance(t *testing.T) {
	isolateNamedInstallation(t, "globex")
	acme := installation.Settings{
		Version:        1,
		Instance:       "acme",
		Mode:           "prod",
		WebPort:        3100,
		WebBindAddress: "127.0.0.1",
		OpenShellPort:  18100,
		DockerSubnet:   "10.224.10.0/24",
	}
	if err := installation.Save(filepath.Join(config.RootDir(), "instances", "acme"), acme); err != nil {
		t.Fatal(err)
	}
	cmd := newSetupCmd()
	for name, value := range map[string]string{
		"port":           "3101",
		"openshell-port": "18101",
		"bind-address":   "127.0.0.1",
		"docker-subnet":  "10.224.10.0/24",
	} {
		if err := cmd.Flags().Set(name, value); err != nil {
			t.Fatal(err)
		}
	}
	_, err := prepareSetupInstallation(context.Background(), cmd, "prod", setupHostOptions{
		webPort:             3101,
		webPortChanged:      true,
		openShellPort:       18101,
		openShellChanged:    true,
		webBindAddress:      "127.0.0.1",
		webBindChanged:      true,
		dockerSubnet:        "10.224.10.0/24",
		dockerSubnetChanged: true,
	})
	if err == nil || !strings.Contains(err.Error(), "subnet 10.224.10.0/24 is reserved by instance acme") {
		t.Fatalf("error = %v", err)
	}
}

func mustPrefixes(t *testing.T, values ...string) []netip.Prefix {
	t.Helper()
	out := make([]netip.Prefix, 0, len(values))
	for _, value := range values {
		prefix, err := netip.ParsePrefix(value)
		if err != nil {
			t.Fatal(err)
		}
		out = append(out, prefix)
	}
	return out
}

func TestNamedRuntimeAndConfigDoNotSharePaths(t *testing.T) {
	base := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(base, "config"))
	t.Setenv("XDG_STATE_HOME", filepath.Join(base, "state"))
	t.Setenv(instance.EnvName, "acme")
	acmeConfig := config.Dir("")
	if err := instance.Select("globex"); err != nil {
		t.Fatal(err)
	}
	globexConfig := config.Dir("")
	if acmeConfig == globexConfig {
		t.Fatalf("instances share config path %q", acmeConfig)
	}
}
