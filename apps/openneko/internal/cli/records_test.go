package cli

import (
	"strings"
	"testing"
)

func TestValidateRecordsDropInputRequiresExactTypedConfirmation(t *testing.T) {
	want := recordsDropConfirmation("crm", "account")
	if want != "DROP crm.account" {
		t.Fatalf("confirmation = %q", want)
	}
	for _, confirmation := range []string{"", "drop crm.account", " DROP crm.account", "DROP crm.account "} {
		if err := validateRecordsDropInput("crm", "account", confirmation); err == nil || !strings.Contains(err.Error(), want) {
			t.Fatalf("expected %q to be rejected with exact confirmation guidance, got %v", confirmation, err)
		}
	}
	if err := validateRecordsDropInput("crm", "account", want); err != nil {
		t.Fatalf("exact typed confirmation rejected: %v", err)
	}
}

func TestValidateRecordsDropInputRejectsUnsafeIdentifiers(t *testing.T) {
	for _, input := range []struct {
		app    string
		object string
	}{
		{"CRM", "account"},
		{"crm;drop schema public", "account"},
		{"crm", "account-name"},
		{"crm", strings.Repeat("a", 64)},
	} {
		if err := validateRecordsDropInput(input.app, input.object, recordsDropConfirmation(input.app, input.object)); err == nil {
			t.Fatalf("expected app=%q object=%q to be rejected", input.app, input.object)
		}
	}
	for _, identifier := range []string{"crm", "n_2fa", "account__c", "_internal"} {
		if !validRecordsCLIIdentifier(identifier) {
			t.Fatalf("expected %q to be accepted", identifier)
		}
	}
}

func TestRecordsDropSQLKeepsDestructionGuarded(t *testing.T) {
	for _, fragment := range []string{
		"must be archived before hard drop",
		"drop table if exists %I.%I",
		"insert into engine.app_schema_log",
		"'hard_drop'",
		"delete from engine.record_object",
		"update engine.record_app",
		"insert into engine.registry_version",
	} {
		if !strings.Contains(strings.ToLower(recordsDropSQL), strings.ToLower(fragment)) {
			t.Fatalf("drop transaction is missing %q", fragment)
		}
	}
	if strings.Contains(strings.ToLower(recordsDropSQL), " cascade") {
		t.Fatal("hard drop must not cascade into unplanned physical dependencies")
	}
}
