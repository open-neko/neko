package cli

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestValidateRecordsImportOptions(t *testing.T) {
	tests := []struct {
		name    string
		options recordsImportOptions
		wantErr string
	}{
		{
			name:    "csv plan example without app",
			options: recordsImportOptions{file: "loans.csv", objectAPIName: "equipment"},
		},
		{
			name:    "artifact plan example",
			options: recordsImportOptions{directory: "sf-export", appID: "crm"},
		},
		{
			name:    "existing request",
			options: recordsImportOptions{requestID: "request-1", yes: true},
		},
		{
			name:    "requires one source",
			options: recordsImportOptions{},
			wantErr: "exactly one",
		},
		{
			name:    "rejects two sources",
			options: recordsImportOptions{file: "a.csv", directory: "export", objectAPIName: "loan"},
			wantErr: "exactly one",
		},
		{
			name:    "csv requires object",
			options: recordsImportOptions{file: "a.csv"},
			wantErr: "--object",
		},
		{
			name:    "artifact requires app",
			options: recordsImportOptions{directory: "export"},
			wantErr: "--app",
		},
		{
			name:    "csv rejects artifact flags",
			options: recordsImportOptions{file: "a.csv", objectAPIName: "loan", label: "Loans"},
			wantErr: "only valid with --dir",
		},
		{
			name:    "artifact rejects csv flags",
			options: recordsImportOptions{directory: "export", appID: "crm", duplicateKey: "id"},
			wantErr: "only valid with --file",
		},
		{
			name:    "request rejects planning flags",
			options: recordsImportOptions{requestID: "request-1", appID: "crm"},
			wantErr: "cannot be combined",
		},
		{
			name:    "rejects unsafe duplicate key",
			options: recordsImportOptions{file: "a.csv", objectAPIName: "loan", duplicateKey: "Loan ID"},
			wantErr: "--duplicate-key",
		},
		{
			name:    "rejects excessive batch size",
			options: recordsImportOptions{file: "a.csv", objectAPIName: "loan", batchSize: 501},
			wantErr: "--batch-size",
		},
		{
			name:    "rejects explicit zero batch size",
			options: recordsImportOptions{file: "a.csv", objectAPIName: "loan", batchSizeSet: true},
			wantErr: "--batch-size",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := validateRecordsImportOptions(test.options)
			if test.wantErr == "" {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), test.wantErr) {
				t.Fatalf("expected error containing %q, got %v", test.wantErr, err)
			}
		})
	}
}

func TestValidateRecordsImportSource(t *testing.T) {
	root := t.TempDir()
	csv := filepath.Join(root, "loans.csv")
	if err := os.WriteFile(csv, []byte("id,name\n1,Drill\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	absolute, err := validateRecordsImportSource(csv, false)
	if err != nil {
		t.Fatalf("valid CSV rejected: %v", err)
	}
	if absolute != csv {
		t.Fatalf("absolute CSV path = %q, want %q", absolute, csv)
	}

	text := filepath.Join(root, "loans.txt")
	if err := os.WriteFile(text, []byte("not csv"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := validateRecordsImportSource(text, false); err == nil || !strings.Contains(err.Error(), ".csv") {
		t.Fatalf("expected non-CSV rejection, got %v", err)
	}

	artifact := filepath.Join(root, "sf-export")
	if err := os.MkdirAll(filepath.Join(artifact, "data"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(artifact, "export-manifest.json"), []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := validateRecordsImportSource(artifact, true); err != nil {
		t.Fatalf("valid artifact directory rejected: %v", err)
	}

	if runtime.GOOS != "windows" {
		link := filepath.Join(artifact, "data", "linked.csv")
		if err := os.Symlink(csv, link); err != nil {
			t.Fatal(err)
		}
		if _, err := validateRecordsImportSource(artifact, true); err == nil || !strings.Contains(err.Error(), "symbolic link") {
			t.Fatalf("expected nested symlink rejection, got %v", err)
		}
	}
}

func TestReadRecordsImportMapping(t *testing.T) {
	root := t.TempDir()
	valid := filepath.Join(root, "mapping.json")
	if err := os.WriteFile(valid, []byte(`{"Loan ID":"id","Ignore":null}`), 0o600); err != nil {
		t.Fatal(err)
	}
	mapping, err := readRecordsImportMapping(valid)
	if err != nil {
		t.Fatalf("valid mapping rejected: %v", err)
	}
	if mapping["Loan ID"] == nil || *mapping["Loan ID"] != "id" || mapping["Ignore"] != nil {
		t.Fatalf("mapping parsed incorrectly: %#v", mapping)
	}

	invalid := filepath.Join(root, "invalid.json")
	if err := os.WriteFile(invalid, []byte(`{"Loan ID":"Loan ID"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := readRecordsImportMapping(invalid); err == nil || !strings.Contains(err.Error(), "records API identifier") {
		t.Fatalf("expected invalid target rejection, got %v", err)
	}
}

func TestRecordsImportPrepareBody(t *testing.T) {
	target := "id"
	body := recordsImportPrepareBody(recordsImportOptions{
		file:          "loans.csv",
		objectAPIName: "loan",
		duplicateKey:  "id",
		batchSize:     75,
	}, "imports/cli/stage/loans.csv", map[string]*string{"Loan ID": &target})
	encoded, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	text := string(encoded)
	for _, fragment := range []string{
		`"mode":"file"`,
		`"object":"loan"`,
		`"duplicateKey":"id"`,
		`"batchSize":75`,
		`"sourcePath":"imports/cli/stage/loans.csv"`,
	} {
		if !strings.Contains(text, fragment) {
			t.Fatalf("prepare body %s is missing %s", text, fragment)
		}
	}
}

func TestWriteRecordsImportPreview(t *testing.T) {
	payload := map[string]any{
		"import_plan": map[string]any{
			"appId":         "equipment",
			"objectApiName": "loan",
			"source":        map[string]any{"name": "loans.csv", "bytes": 42},
			"rowCount":      2,
			"duplicateKey":  "id",
			"batchSize":     50,
			"columns": []map[string]any{
				{"sourceColumn": "Loan ID", "targetField": "id", "targetKind": "id"},
				{"sourceColumn": "Ignore", "targetField": nil, "targetKind": nil},
			},
			"sampleRows": []map[string]string{{"Loan ID": "L-1", "Ignore": "\x1b[31mred"}},
			"warnings":   []string{"one column is skipped"},
		},
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	err = writeRecordsImportPreview(&out, recordsImportActionRequest{
		ID:      "request-1",
		Kind:    "records_import_start",
		Status:  "pending_approval",
		Payload: raw,
	})
	if err != nil {
		t.Fatalf("preview failed: %v", err)
	}
	text := out.String()
	for _, fragment := range []string{
		"Prepared records import request-1",
		"Target: equipment.loan",
		"Source: loans.csv (2 rows, 42 bytes)",
		"Loan ID -> id (id)",
		"Ignore -> skip",
		"Warnings:",
		"Sample rows:",
	} {
		if !strings.Contains(text, fragment) {
			t.Fatalf("preview is missing %q:\n%s", fragment, text)
		}
	}
	if strings.ContainsRune(text, '\x1b') {
		t.Fatalf("preview emitted a terminal escape: %q", text)
	}
}

func TestRecordsCommandExposesGovernedImportFlags(t *testing.T) {
	command, _, err := newRecordsCmd().Find([]string{"import"})
	if err != nil {
		t.Fatal(err)
	}
	if command.Name() != "import" {
		t.Fatalf("found command %q, want import", command.Name())
	}
	for _, name := range []string{
		"app", "object", "file", "dir", "request", "mapping", "duplicate-key", "batch-size", "yes",
	} {
		if command.Flags().Lookup(name) == nil {
			t.Fatalf("import command is missing --%s", name)
		}
	}
}

func TestValidateRecordsImportContainerRoot(t *testing.T) {
	valid := filepath.Join(string(filepath.Separator), "tmp", "openneko-home", "org-a", "imports", "cli")
	if got, err := validateRecordsImportContainerRoot(valid); err != nil || got != filepath.Clean(valid) {
		t.Fatalf("valid container root rejected: got %q, err %v", got, err)
	}
	for _, invalid := range []string{"imports/cli", "/", "/tmp/openneko-home/org-a/imports"} {
		if _, err := validateRecordsImportContainerRoot(invalid); err == nil {
			t.Fatalf("expected %q to be rejected", invalid)
		}
	}
}
