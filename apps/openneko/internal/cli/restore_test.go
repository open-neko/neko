package cli

import (
	"strings"
	"testing"
	"time"
)

func TestNormalizeRestoreTarget(t *testing.T) {
	now := time.Date(2026, 8, 2, 20, 0, 0, 0, time.UTC)
	got, err := normalizeRestoreTarget("2026-08-02T21:15:30+02:00", now)
	if err != nil {
		t.Fatal(err)
	}
	if got != "2026-08-02T19:15:30Z" {
		t.Fatalf("normalized target = %q", got)
	}
}

func TestValidateRestoreConfirmation(t *testing.T) {
	for _, raw := range []string{"", "restore", " RESTORE", "RESTORE "} {
		if err := validateRestoreConfirmation(raw); err == nil || !strings.Contains(err.Error(), "--confirm RESTORE") {
			t.Fatalf("expected %q to be rejected with typed-confirmation guidance", raw)
		}
	}
	if err := validateRestoreConfirmation("RESTORE"); err != nil {
		t.Fatalf("exact typed confirmation rejected: %v", err)
	}
}

func TestNormalizeRestoreTargetRejectsInvalidOrFuture(t *testing.T) {
	now := time.Date(2026, 8, 2, 20, 0, 0, 0, time.UTC)
	for _, raw := range []string{"", "2026-08-02 19:00:00", "2026-08-02T21:00:00Z"} {
		if _, err := normalizeRestoreTarget(raw, now); err == nil {
			t.Fatalf("expected %q to be rejected", raw)
		}
	}
}
