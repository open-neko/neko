package cli

import (
	"context"
	"reflect"
	"testing"

	"github.com/open-neko/neko/apps/openneko/internal/compose"
)

func TestNormalizeUpgradeImageVersion(t *testing.T) {
	tests := map[string]string{
		"":                      "latest",
		"  ":                    "latest",
		"latest":                "latest",
		"v1.2.3":                "v1.2.3",
		"1.2.3":                 "v1.2.3",
		"1.2.3-rc.1+build.123":  "v1.2.3-rc.1+build.123",
		"sha-1234567890abcdef":  "sha-1234567890abcdef",
		"release-candidate-tag": "release-candidate-tag",
	}
	for in, want := range tests {
		if got := normalizeUpgradeImageVersion(in); got != want {
			t.Fatalf("normalizeUpgradeImageVersion(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestResolveUpgradeMode(t *testing.T) {
	s := &compose.Supervisor{RuntimeDir: t.TempDir()}
	stubComposeProjects(t, []string{"openneko-prod"}, []string{"openneko-prod"})
	if _, err := s.ProjectName(compose.ModeDemo); err != nil {
		t.Fatal(err)
	}
	mode, defaulted, err := resolveUpgradeMode(context.Background(), "auto", s)
	if err != nil {
		t.Fatal(err)
	}
	if mode != compose.ModeDemo || defaulted {
		t.Fatalf("mode=%q defaulted=%v, want demo false", mode, defaulted)
	}

	mode, defaulted, err = resolveUpgradeMode(context.Background(), "prod", s)
	if err != nil {
		t.Fatal(err)
	}
	if mode != compose.ModeProd || defaulted {
		t.Fatalf("mode=%q defaulted=%v, want prod false", mode, defaulted)
	}

	_, _, err = resolveUpgradeMode(context.Background(), "bogus", s)
	if err == nil {
		t.Fatal("expected invalid mode error")
	}
}

func TestResolveUpgradeModeDefaultsProdWithoutMarker(t *testing.T) {
	s := &compose.Supervisor{RuntimeDir: t.TempDir()}
	stubComposeProjects(t, nil, nil)
	mode, defaulted, err := resolveUpgradeMode(context.Background(), "auto", s)
	if err != nil {
		t.Fatal(err)
	}
	if mode != compose.ModeProd || !defaulted {
		t.Fatalf("mode=%q defaulted=%v, want prod true", mode, defaulted)
	}
}

func TestResolveUpgradeModeDetectsRunningLegacyStack(t *testing.T) {
	s := &compose.Supervisor{RuntimeDir: t.TempDir()}
	stubComposeProjects(t, []string{"openneko-demo"}, []string{"openneko-demo"})

	mode, defaulted, err := resolveUpgradeMode(context.Background(), "auto", s)
	if err != nil {
		t.Fatal(err)
	}
	if mode != compose.ModeDemo || defaulted {
		t.Fatalf("mode=%q defaulted=%v, want demo false", mode, defaulted)
	}
}

func TestResolveUpgradeModeDetectsStoppedLegacyStack(t *testing.T) {
	s := &compose.Supervisor{RuntimeDir: t.TempDir()}
	stubComposeProjects(t, nil, []string{"openneko-dev"})

	mode, defaulted, err := resolveUpgradeMode(context.Background(), "auto", s)
	if err != nil {
		t.Fatal(err)
	}
	if mode != compose.ModeDev || defaulted {
		t.Fatalf("mode=%q defaulted=%v, want dev false", mode, defaulted)
	}
}

func TestResolveUpgradeModeDetectsLegacyProdProject(t *testing.T) {
	s := &compose.Supervisor{RuntimeDir: t.TempDir()}
	stubComposeProjects(t, []string{"openneko"}, []string{"openneko"})

	mode, defaulted, err := resolveUpgradeMode(context.Background(), "auto", s)
	if err != nil {
		t.Fatal(err)
	}
	if mode != compose.ModeProd || defaulted {
		t.Fatalf("mode=%q defaulted=%v, want prod false", mode, defaulted)
	}
}

func TestResolveUpgradeModeErrorsOnMultipleStacks(t *testing.T) {
	s := &compose.Supervisor{RuntimeDir: t.TempDir()}
	stubComposeProjects(t, []string{"openneko-dev", "openneko-demo"}, []string{"openneko-dev", "openneko-demo"})

	_, _, err := resolveUpgradeMode(context.Background(), "auto", s)
	if err == nil {
		t.Fatal("expected multiple stack error")
	}
}

func TestOldOpenNekoImageRefs(t *testing.T) {
	in := `
ghcr.io/open-neko/neko-web:v1.0.0
ghcr.io/open-neko/neko-web:v2.0.0
ghcr.io/open-neko/neko-worker:v1.0.0
ghcr.io/open-neko/agent:<none>
postgres:16-alpine
ghcr.io/open-neko/plugin-base:v0.9.0
ghcr.io/open-neko/plugin-base:v0.9.0
`
	want := []string{
		"ghcr.io/open-neko/neko-web:v1.0.0",
		"ghcr.io/open-neko/neko-worker:v1.0.0",
		"ghcr.io/open-neko/plugin-base:v0.9.0",
	}
	if got := oldOpenNekoImageRefs(in, "v2.0.0"); !reflect.DeepEqual(got, want) {
		t.Fatalf("oldOpenNekoImageRefs = %#v, want %#v", got, want)
	}
}

func TestExtraUpgradeImageRefsDedupesOverrides(t *testing.T) {
	t.Setenv("OPENNEKO_AGENT_IMAGE", "custom/agent:v1")
	t.Setenv("OPENNEKO_PLUGIN_BASE_IMAGE", "custom/agent:v1")
	got := extraUpgradeImageRefs("v2.0.0")
	want := []string{"custom/agent:v1"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("extraUpgradeImageRefs = %#v, want %#v", got, want)
	}
}

func stubComposeProjects(t *testing.T, running, all []string) {
	t.Helper()
	previous := listDockerComposeProjectNames
	t.Cleanup(func() {
		listDockerComposeProjectNames = previous
	})
	listDockerComposeProjectNames = func(_ context.Context, includeStopped bool) ([]string, error) {
		if includeStopped {
			return all, nil
		}
		return running, nil
	}
}
