package assets

import (
	"fmt"
	"os"
	"reflect"
	"sort"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

type composeParityDocument struct {
	Services map[string]composeParityService `yaml:"services"`
	Volumes  map[string]any                  `yaml:"volumes"`
}

type composeParityService struct {
	Image       string                             `yaml:"image"`
	Entrypoint  []string                           `yaml:"entrypoint"`
	Restart     string                             `yaml:"restart"`
	Profiles    []string                           `yaml:"profiles"`
	DependsOn   map[string]composeParityDependency `yaml:"depends_on"`
	Environment map[string]any                     `yaml:"environment"`
	Volumes     []string                           `yaml:"volumes"`
	Ports       []string                           `yaml:"ports"`
	Command     []string                           `yaml:"command"`
	Healthcheck map[string]any                     `yaml:"healthcheck"`
}

func TestPackagedGraphJinReusesReleasedRuntime(t *testing.T) {
	coreRaw, err := ComposeFS.ReadFile("compose/core.yml")
	if err != nil {
		t.Fatal(err)
	}
	core := loadComposeParityDocument(t, coreRaw)
	graphjin, ok := core.Services["graphjin"]
	if !ok {
		t.Fatal("packaged core is missing graphjin")
	}
	if !strings.Contains(graphjin.Image, "ghcr.io/open-neko/records-graphjin:") {
		t.Fatalf("packaged graphjin image = %q, want the shared records-graphjin runtime", graphjin.Image)
	}
	if want := []string{"/bin/sh", "/config/.openneko-graphjin-supervisor.sh"}; !reflect.DeepEqual(graphjin.Entrypoint, want) {
		t.Fatalf("packaged graphjin entrypoint = %v, want %v", graphjin.Entrypoint, want)
	}
	configInit, ok := core.Services["graphjin-config-init"]
	if !ok {
		t.Fatal("packaged core is missing graphjin-config-init")
	}
	if !strings.Contains(strings.Join(configInit.Entrypoint, "\n"), "graphjin-supervisor.sh") {
		t.Fatal("packaged graphjin config init does not install the supervisor entrypoint")
	}

	demoRaw, err := ComposeFS.ReadFile("compose/demo.yml")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(demoRaw), "dosco/graphjin") {
		t.Fatal("packaged demo restores the duplicate upstream GraphJin image")
	}
}

func TestVendoredAgentBinaryCannotBeOverridden(t *testing.T) {
	rootRaw, err := os.ReadFile("../../../compose.openshell.yml")
	if err != nil {
		t.Fatal(err)
	}
	packagedRaw, err := ComposeFS.ReadFile("compose/openshell.yml")
	if err != nil {
		t.Fatal(err)
	}
	for label, document := range map[string]composeParityDocument{
		"source":   loadComposeParityDocument(t, rootRaw),
		"packaged": loadComposeParityDocument(t, packagedRaw),
	} {
		for _, serviceName := range []string{"web", "worker"} {
			if _, exists := document.Services[serviceName].Environment["OPENNEKO_AGENT_MODEL_BINARY"]; exists {
				t.Fatalf("%s %s exposes an override for the vendored agent executable", label, serviceName)
			}
		}
	}
}

func TestStorageReconciliationGatesEveryDatabaseConsumer(t *testing.T) {
	rootRaw, err := os.ReadFile("../../../compose.yml")
	if err != nil {
		t.Fatal(err)
	}
	packagedRaw, err := ComposeFS.ReadFile("compose/core.yml")
	if err != nil {
		t.Fatal(err)
	}
	for label, document := range map[string]composeParityDocument{
		"source":   loadComposeParityDocument(t, rootRaw),
		"packaged": loadComposeParityDocument(t, packagedRaw),
	} {
		reconcile, ok := document.Services["storage-reconcile"]
		if !ok {
			t.Fatalf("%s compose is missing storage-reconcile", label)
		}
		if want := []string{"storage", "reconcile"}; !reflect.DeepEqual(reconcile.Command, want) {
			t.Fatalf("%s storage-reconcile command = %v, want %v", label, reconcile.Command, want)
		}
		for _, database := range []string{"neko-db", "records-db"} {
			if reconcile.DependsOn[database].Condition != "service_healthy" {
				t.Fatalf("%s storage-reconcile must wait for healthy %s", label, database)
			}
		}
		for _, key := range []string{
			"NEKO_PG_HOST", "NEKO_PG_DATABASE", "RECORDS_PG_HOST", "RECORDS_PG_DATABASE",
		} {
			if _, ok := reconcile.Environment[key]; !ok {
				t.Fatalf("%s storage-reconcile is missing %s", label, key)
			}
		}
		migrate := document.Services["neko-migrate"]
		if _, ok := migrate.Environment["OPENNEKO_OPENSHELL_DB_PASSWORD"]; !ok {
			t.Fatalf("%s neko-migrate is missing the propagated OpenShell credential", label)
		}
		if got := migrate.Environment["OPENNEKO_REQUIRE_EXPLICIT_OPENSHELL_DB_PASSWORD"]; got != "1" {
			t.Fatalf("%s neko-migrate explicit-credential guard = %v, want 1", label, got)
		}
		for _, consumer := range []string{
			"neko-migrate", "neko-backup", "records-graphjin", "records-watch-graphjin",
		} {
			if document.Services[consumer].DependsOn["storage-reconcile"].Condition != "service_completed_successfully" {
				t.Fatalf("%s %s can start before storage reconciliation", label, consumer)
			}
		}
	}
}

func TestDatabaseImagesEnforcePinnedGlibcStorageABI(t *testing.T) {
	root := repoRootForTest(t)
	dockerfile, err := os.ReadFile(root + "/Dockerfile")
	if err != nil {
		t.Fatal(err)
	}
	raw := string(dockerfile)
	for _, required := range []string{
		"FROM pgvector/pgvector:0.8.6-pg16-bookworm@sha256:ccc6e83d6e35e931dc7c5def2022729d5a6c370318d099181995567ff1fb4d6b AS postgres-runtime",
		`LABEL org.openneko.storage-contract="1"`,
		`test "$(getconf GNU_LIBC_VERSION)" = "glibc 2.36"`,
		"FROM postgres-runtime AS neko-db",
		"FROM postgres-runtime AS records-db",
	} {
		if !strings.Contains(raw, required) {
			t.Fatalf("Dockerfile does not enforce storage ABI line %q", required)
		}
	}
	if strings.Contains(raw, "FROM postgres:16-alpine AS postgres-runtime") {
		t.Fatal("stateful database runtime regressed to Alpine/musl")
	}
}

type composeParityDependency struct {
	Condition string `yaml:"condition"`
}

type composeParityInventory struct {
	Restart        string
	Profiles       []string
	Dependencies   []string
	Environment    []string
	Mounts         []string
	Command        []string
	HasHealthcheck bool
}

func loadComposeParityDocument(t *testing.T, raw []byte) composeParityDocument {
	t.Helper()
	var document composeParityDocument
	if err := yaml.Unmarshal(raw, &document); err != nil {
		t.Fatalf("parse compose YAML: %v", err)
	}
	return document
}

func sortedKeys[T any](values map[string]T) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func normalizeComposeMount(mount string) string {
	separator := strings.Index(mount, ":")
	if strings.HasPrefix(mount, "${") {
		if end := strings.Index(mount, "}"); end >= 0 {
			if offset := strings.Index(mount[end+1:], ":"); offset >= 0 {
				separator = end + 1 + offset
			}
		}
	}
	if separator < 0 {
		return mount
	}
	source := mount[:separator]
	if strings.HasPrefix(source, "${") && strings.HasSuffix(source, "}") {
		variable := strings.TrimSuffix(strings.TrimPrefix(source, "${"), "}")
		name, modifier, _ := strings.Cut(variable, ":")
		if name == "OPENNEKO_CONFIG_VOLUME" && strings.HasPrefix(modifier, "-") {
			source = strings.TrimPrefix(modifier, "-")
		} else {
			source = "$" + name
		}
	}
	return source + mount[separator:]
}

func composeParityInventoryFor(service composeParityService) composeParityInventory {
	dependencies := make([]string, 0, len(service.DependsOn))
	for name, dependency := range service.DependsOn {
		dependencies = append(dependencies, fmt.Sprintf("%s:%s", name, dependency.Condition))
	}
	sort.Strings(dependencies)
	mounts := make([]string, len(service.Volumes))
	for index, mount := range service.Volumes {
		mounts[index] = normalizeComposeMount(mount)
	}
	sort.Strings(mounts)
	profiles := append([]string(nil), service.Profiles...)
	sort.Strings(profiles)
	return composeParityInventory{
		Restart:        service.Restart,
		Profiles:       profiles,
		Dependencies:   dependencies,
		Environment:    sortedKeys(service.Environment),
		Mounts:         mounts,
		Command:        service.Command,
		HasHealthcheck: len(service.Healthcheck) > 0,
	}
}

func withoutMount(mounts []string, ignored string) []string {
	filtered := make([]string, 0, len(mounts))
	for _, mount := range mounts {
		if mount != ignored {
			filtered = append(filtered, mount)
		}
	}
	return filtered
}

func composeHealthcheckTest(t *testing.T, label, serviceName string, service composeParityService) []string {
	t.Helper()
	raw, ok := service.Healthcheck["test"].([]any)
	if !ok {
		t.Fatalf("%s %s healthcheck test is not a command: %#v", label, serviceName, service.Healthcheck["test"])
	}
	command := make([]string, len(raw))
	for index, value := range raw {
		argument, ok := value.(string)
		if !ok {
			t.Fatalf("%s %s healthcheck argument %d is not a string: %#v", label, serviceName, index, value)
		}
		command[index] = argument
	}
	return command
}

func TestSourceAndPackagedComposeStateInventoryMatch(t *testing.T) {
	rootRaw, err := os.ReadFile("../../../compose.yml")
	if err != nil {
		t.Fatal(err)
	}
	packagedRaw, err := ComposeFS.ReadFile("compose/core.yml")
	if err != nil {
		t.Fatal(err)
	}
	root := loadComposeParityDocument(t, rootRaw)
	packaged := loadComposeParityDocument(t, packagedRaw)

	if got, want := sortedKeys(root.Volumes), sortedKeys(packaged.Volumes); !reflect.DeepEqual(got, want) {
		t.Fatalf("named-volume inventory drifted:\nsource:   %v\npackaged: %v", got, want)
	}
	if got, want := sortedKeys(root.Services), sortedKeys(packaged.Services); !reflect.DeepEqual(got, want) {
		t.Fatalf("service inventory drifted:\nsource:   %v\npackaged: %v", got, want)
	}
	for _, name := range sortedKeys(root.Services) {
		got := composeParityInventoryFor(root.Services[name])
		want := composeParityInventoryFor(packaged.Services[name])
		if name == "graphjin-config-init" {
			// Source compose reads immutable seeds from the checkout. Packaged
			// compose reads the same paths baked into neko-worker, so it correctly
			// has no host bind mounts for these inputs.
			got.Mounts = withoutMount(
				got.Mounts,
				"./db/graphjin/customer.sources.example.yml:/seed/customer.sources.yml:ro",
			)
			got.Mounts = withoutMount(
				got.Mounts,
				"./scripts/graphjin-supervisor.sh:/seed/graphjin-supervisor.sh:ro",
			)
		}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("service %s state/recovery inventory drifted:\nsource:   %#v\npackaged: %#v", name, got, want)
		}
	}
}

func TestRecordsGraphJinEndpointsRemainPrivate(t *testing.T) {
	rootRaw, err := os.ReadFile("../../../compose.yml")
	if err != nil {
		t.Fatal(err)
	}
	packagedRaw, err := ComposeFS.ReadFile("compose/core.yml")
	if err != nil {
		t.Fatal(err)
	}
	for label, document := range map[string]composeParityDocument{
		"source":   loadComposeParityDocument(t, rootRaw),
		"packaged": loadComposeParityDocument(t, packagedRaw),
	} {
		wantHealthcheck := []string{
			"CMD", "curl", "-sS", "-o", "/dev/null",
			"http://127.0.0.1:8090/api/v1/graphql",
		}
		for _, serviceName := range []string{"records-graphjin", "records-watch-graphjin"} {
			service, ok := document.Services[serviceName]
			if !ok {
				t.Fatalf("%s compose is missing %s", label, serviceName)
			}
			if len(service.Ports) != 0 {
				t.Errorf("%s %s must not publish host ports: %v", label, serviceName, service.Ports)
			}
			if got := composeHealthcheckTest(t, label, serviceName, service); !reflect.DeepEqual(got, wantHealthcheck) {
				t.Errorf("%s %s healthcheck must accept an authenticated-error HTTP response as ready:\ngot:  %v\nwant: %v", label, serviceName, got, wantHealthcheck)
			}
		}
	}
}

func TestPackagedDemoBootstrapsJWTBeforeServingWeb(t *testing.T) {
	raw, err := ComposeFS.ReadFile("compose/demo.yml")
	if err != nil {
		t.Fatal(err)
	}
	demo := loadComposeParityDocument(t, raw)

	seed := demo.Services["neko-adventureworks-seed"]
	if got := seed.Environment["ADVENTUREWORKS_AUTH_MODE"]; got != "jwt" {
		t.Fatalf("demo seed auth mode = %#v, want jwt", got)
	}
	if got := seed.Environment["ADVENTUREWORKS_RECONCILE_AUTH_MODE"]; got != "1" {
		t.Fatalf("demo auth reconciliation = %#v, want 1", got)
	}

	worker := demo.Services["worker"]
	if got := worker.DependsOn["neko-adventureworks-seed"].Condition; got != "service_completed_successfully" {
		t.Fatalf("worker demo-seed dependency = %q, want service_completed_successfully", got)
	}
	web := demo.Services["web"]
	if got := web.DependsOn["worker"].Condition; got != "service_healthy" {
		t.Fatalf("web worker dependency = %q, want service_healthy", got)
	}
	for _, serviceName := range []string{"web", "worker"} {
		if got := demo.Services[serviceName].Environment["OPENNEKO_STACK_MODE"]; got != "demo" {
			t.Fatalf("%s stack mode = %#v, want demo", serviceName, got)
		}
	}

	coreRaw, err := ComposeFS.ReadFile("compose/core.yml")
	if err != nil {
		t.Fatal(err)
	}
	prod := loadComposeParityDocument(t, coreRaw)
	for _, serviceName := range []string{"web", "worker"} {
		if got, exists := prod.Services[serviceName].Environment["OPENNEKO_STACK_MODE"]; exists {
			t.Fatalf("production %s unexpectedly sets OPENNEKO_STACK_MODE=%#v", serviceName, got)
		}
	}
}
