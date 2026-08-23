package cli

import (
	"reflect"
	"strings"
	"testing"

	"github.com/open-neko/neko/apps/openneko/internal/plugin/marketplace"
)

func TestSetupRetainsHermesOnlyBackendFlagCompatibility(t *testing.T) {
	flag := newSetupCmd().Flags().Lookup("backend")
	if flag == nil || flag.Deprecated == "" {
		t.Fatal("setup must retain the deprecated --backend flag for older automation")
	}
	if err := validateLegacyAgentBackend("hermes"); err != nil {
		t.Fatalf("legacy --backend hermes must remain accepted: %v", err)
	}
	err := validateLegacyAgentBackend("removed-runtime")
	if err == nil || !strings.Contains(err.Error(), "Hermes is the only agent runtime") {
		t.Fatalf("removed backend must fail with a Hermes-only message, got %v", err)
	}
}

func TestSplitCSV(t *testing.T) {
	got := splitCSV("a, b ,,c ")
	want := []string{"a", "b", "c"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("splitCSV = %v, want %v", got, want)
	}
	if got := splitCSV("  "); got != nil {
		t.Fatalf("splitCSV(blank) = %v, want nil", got)
	}
}

func TestResolvePluginSelection(t *testing.T) {
	plugins := []marketplace.Plugin{
		{Name: "@x/a"}, {Name: "@x/b"}, {Name: "@x/c"},
	}
	cases := []struct {
		in   string
		want []string
	}{
		{"", nil},
		{"all", []string{"@x/a", "@x/b", "@x/c"}},
		{"ALL", []string{"@x/a", "@x/b", "@x/c"}},
		{"1,3", []string{"@x/a", "@x/c"}},
		{"@x/b", []string{"@x/b"}},
		{"2, @x/a", []string{"@x/b", "@x/a"}},
		{"9", nil},                     // out of range
		{"nope", nil},                  // unknown name
		{"1,@x/a,1", []string{"@x/a"}}, // de-duped
	}
	for _, c := range cases {
		got := resolvePluginSelection(c.in, plugins)
		if !reflect.DeepEqual(got, c.want) {
			t.Errorf("resolvePluginSelection(%q) = %v, want %v", c.in, got, c.want)
		}
	}
}
