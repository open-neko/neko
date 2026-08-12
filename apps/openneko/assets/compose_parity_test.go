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
	Restart     string                             `yaml:"restart"`
	Profiles    []string                           `yaml:"profiles"`
	DependsOn   map[string]composeParityDependency `yaml:"depends_on"`
	Environment map[string]any                     `yaml:"environment"`
	Volumes     []string                           `yaml:"volumes"`
	Ports       []string                           `yaml:"ports"`
	Command     []string                           `yaml:"command"`
	Healthcheck map[string]any                     `yaml:"healthcheck"`
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
			// Source compose reads the neutral seed from the checkout. Packaged
			// compose reads the same path baked into neko-worker, so it correctly
			// has no host bind mount for this immutable input.
			got.Mounts = withoutMount(
				got.Mounts,
				"./db/graphjin/customer.sources.example.yml:/seed/customer.sources.yml:ro",
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
