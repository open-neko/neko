package assets

import (
	"io/fs"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

type composeServiceForTest struct {
	Ports       []string                     `yaml:"ports"`
	Expose      []string                     `yaml:"expose"`
	Environment map[string]string            `yaml:"environment"`
	DependsOn   map[string]composeDepForTest `yaml:"depends_on"`
	Volumes     []string                     `yaml:"volumes"`
}

func TestPackagedComposeUsesReadOnlyBackupKeyFiles(t *testing.T) {
	core, raw := readComposeForTest(t, "core.yml")
	if strings.Contains(raw, "OPENNEKO_BACKUP_CIPHER_PASS") {
		t.Fatal("packaged Compose must not interpolate the backup key into container environment metadata")
	}
	for _, name := range []string{"neko-db", "records-db", "neko-backup", "neko-restore"} {
		service := core.Services[name]
		if got := service.Environment["PGBACKREST_REPO1_CIPHER_PASS_FILE"]; got != "/run/secrets/openneko-backup-key" {
			t.Fatalf("%s backup key file = %q", name, got)
		}
		wantMount := "${OPENNEKO_BACKUP_KEY_FILE:?OPENNEKO_BACKUP_KEY_FILE is required}:/run/secrets/openneko-backup-key:ro"
		found := false
		for _, mount := range service.Volumes {
			if mount == wantMount {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("%s is missing read-only backup key mount", name)
		}
	}
}

type composeDepForTest struct {
	Condition string `yaml:"condition"`
}

type composeFileForTest struct {
	Services map[string]composeServiceForTest `yaml:"services"`
}

func readComposeForTest(t *testing.T, name string) (composeFileForTest, string) {
	t.Helper()
	raw, err := fs.ReadFile(ComposeFS, "compose/"+name)
	if err != nil {
		t.Fatal(err)
	}
	var doc composeFileForTest
	if err := yaml.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("parse %s: %v", name, err)
	}
	return doc, string(raw)
}

func TestPackagedComposeExposesOnlyWebToLAN(t *testing.T) {
	core, _ := readComposeForTest(t, "core.yml")
	for name, service := range core.Services {
		if name == "web" {
			want := "${OPENNEKO_WEB_BIND_ADDRESS:-0.0.0.0}:${OPENNEKO_PORT:-3000}:8080"
			if len(service.Ports) != 1 || service.Ports[0] != want {
				t.Fatalf("web ports = %v, want only %q", service.Ports, want)
			}
			continue
		}
		if len(service.Ports) != 0 {
			t.Fatalf("packaged service %s unexpectedly publishes host ports: %v", name, service.Ports)
		}
	}

	demo, _ := readComposeForTest(t, "demo.yml")
	for name, service := range demo.Services {
		if len(service.Ports) != 0 {
			t.Fatalf("demo.yml service %s unexpectedly publishes host ports: %v", name, service.Ports)
		}
	}

	openshell, _ := readComposeForTest(t, "openshell.yml")
	for name, service := range openshell.Services {
		if name == "openshell-gateway" {
			want := "127.0.0.1:${OPENSHELL_PORT:-18080}:${OPENSHELL_PORT:-18080}"
			if len(service.Ports) != 1 || service.Ports[0] != want {
				t.Fatalf("gateway ports = %v, want only loopback %q", service.Ports, want)
			}
			continue
		}
		if len(service.Ports) != 0 {
			t.Fatalf("openshell.yml service %s unexpectedly publishes host ports: %v", name, service.Ports)
		}
	}
}

func TestPackagedComposeKeepsRuntimeTrafficOnDockerNetwork(t *testing.T) {
	core, _ := readComposeForTest(t, "core.yml")
	for service, port := range map[string]string{
		"neko-db":       "5432",
		"records-db":    "5432",
		"graphjin":      "8080",
		"neko-graphjin": "8089",
	} {
		got := core.Services[service].Expose
		if len(got) != 1 || got[0] != port {
			t.Fatalf("%s expose = %v, want internal port %s", service, got, port)
		}
	}

	migrate := core.Services["neko-migrate"]
	if migrate.Environment["NEKO_PG_HOST"] != "neko-db" {
		t.Fatalf("migration host = %q, want Docker service neko-db", migrate.Environment["NEKO_PG_HOST"])
	}
	if _, ok := migrate.Environment["OPENNEKO_OPENSHELL_DB_PASSWORD"]; !ok {
		t.Fatal("migration service must receive the gateway-role password")
	}
	if core.Services["web"].DependsOn["worker"].Condition != "service_healthy" {
		t.Fatal("web must start after the worker control plane is healthy")
	}

	openshell, raw := readComposeForTest(t, "openshell.yml")
	gateway := openshell.Services["openshell-gateway"]
	if gateway.DependsOn["neko-migrate"].Condition != "service_completed_successfully" {
		t.Fatal("OpenShell gateway must wait for private database preparation")
	}
	for _, service := range []string{"worker", "web"} {
		env := openshell.Services[service].Environment
		if env["OPENNEKO_SANDBOX_SHARED_NETWORK"] != "1" {
			t.Fatalf("%s shared-network broker config is incomplete: %v", service, env)
		}
		if _, exposed := env["OPENNEKO_BROKER_HOST_ALIAS"]; exposed {
			t.Fatalf("%s must derive a private container IP instead of a host broker alias", service)
		}
	}
	for _, required := range []string{
		`network_name = "%s"`,
		`grpc_endpoint = "https://host.openshell.internal:%s"`,
		`OPENNEKO_COMPOSE_NETWORK: "${COMPOSE_PROJECT_NAME}_default"`,
	} {
		if !strings.Contains(raw, required) {
			t.Fatalf("openshell.yml missing %q", required)
		}
	}
}
