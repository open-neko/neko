package cli

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"unicode"

	"github.com/spf13/cobra"

	"github.com/open-neko/neko/apps/openneko/internal/prompt"
)

const (
	recordsImportAdminBaseURL = "http://127.0.0.1:4100/admin/records/import"
	recordsImportMaxFileSize  = int64(256 << 20)
	recordsImportMaxDirSize   = int64(1 << 30)
)

type recordsImportOptions struct {
	appID         string
	objectAPIName string
	file          string
	directory     string
	requestID     string
	label         string
	purpose       string
	mappingFile   string
	duplicateKey  string
	batchSize     int
	batchSizeSet  bool
	ownerUserID   string
	yes           bool
}

type recordsImportStagingResponse struct {
	OrgID         string `json:"orgId"`
	ContainerRoot string `json:"containerRoot"`
}

type recordsImportPreparedResponse struct {
	Request recordsImportActionRequest `json:"request"`
}

type recordsImportActionRequest struct {
	ID      string          `json:"id"`
	Kind    string          `json:"kind"`
	Status  string          `json:"status"`
	Payload json.RawMessage `json:"payload"`
}

type recordsImportStartResponse struct {
	RequestID string  `json:"requestId"`
	Status    string  `json:"status"`
	JobID     *string `json:"jobId"`
}

type recordsCSVImportPlan struct {
	AppID         string `json:"appId"`
	ObjectAPIName string `json:"objectApiName"`
	Source        struct {
		Name  string `json:"name"`
		Bytes int64  `json:"bytes"`
	} `json:"source"`
	RowCount   int                 `json:"rowCount"`
	SampleRows []map[string]string `json:"sampleRows"`
	Columns    []struct {
		SourceColumn string  `json:"sourceColumn"`
		TargetField  *string `json:"targetField"`
		TargetKind   *string `json:"targetKind"`
	} `json:"columns"`
	DuplicateKey string   `json:"duplicateKey"`
	BatchSize    int      `json:"batchSize"`
	Warnings     []string `json:"warnings"`
}

type recordsArtifactImportPlan struct {
	Directory  string `json:"directory"`
	Definition struct {
		AppID   string `json:"appId"`
		Label   string `json:"label"`
		Objects []struct {
			APIName string `json:"apiName"`
			Label   string `json:"label"`
		} `json:"objects"`
	} `json:"definition"`
	Imports  []recordsCSVImportPlan `json:"imports"`
	Warnings []string               `json:"warnings"`
}

type recordsPreparedPayload struct {
	ImportPlan         *recordsCSVImportPlan      `json:"import_plan"`
	ArtifactImportPlan *recordsArtifactImportPlan `json:"artifact_import_plan"`
}

func newRecordsImportCmd() *cobra.Command {
	var options recordsImportOptions
	cmd := &cobra.Command{
		Use:   "import (--file <csv> --object <object> | --dir <artifact>) [flags]",
		Short: "Prepare and start a governed CSV or artifact-directory import",
		Long: `Stage a host CSV or connector artifact directory in the worker workspace,
prepare the normal immutable records import plan, and show it before approval.
Without --yes, interactive terminals ask before starting; non-interactive runs
leave the prepared request pending so it can be started later with --request.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			options.batchSizeSet = cmd.Flags().Changed("batch-size")
			return runRecordsImport(cmd.Context(), cmd, options)
		},
	}
	flags := cmd.Flags()
	flags.StringVar(&options.appID, "app", "", "target records app API identifier (required for --dir)")
	flags.StringVar(&options.objectAPIName, "object", "", "target records object API identifier (required for --file)")
	flags.StringVar(&options.file, "file", "", "host path to one CSV file")
	flags.StringVar(&options.directory, "dir", "", "host path to an artifact directory")
	flags.StringVar(&options.requestID, "request", "", "start an already-prepared CLI import request")
	flags.StringVar(&options.label, "label", "", "app label for an artifact import")
	flags.StringVar(&options.purpose, "purpose", "", "app purpose for an artifact import")
	flags.StringVar(&options.mappingFile, "mapping", "", "JSON file mapping CSV columns to field names or null")
	flags.StringVar(&options.duplicateKey, "duplicate-key", "", "target field used to report duplicate rows")
	flags.IntVar(&options.batchSize, "batch-size", 0, "rows per durable import batch (1-500)")
	flags.StringVar(&options.ownerUserID, "owner-user-id", "", "owner assigned to imported records")
	flags.BoolVarP(&options.yes, "yes", "y", false, "approve and queue the reviewed import without prompting")
	return cmd
}

func validateRecordsImportOptions(options recordsImportOptions) error {
	batchSizeProvided := options.batchSizeSet || options.batchSize != 0
	if options.requestID != "" {
		if strings.TrimSpace(options.requestID) != options.requestID {
			return fmt.Errorf("--request must not have surrounding whitespace")
		}
		if options.file != "" || options.directory != "" || options.appID != "" ||
			options.objectAPIName != "" || options.label != "" || options.purpose != "" ||
			options.mappingFile != "" || options.duplicateKey != "" || batchSizeProvided ||
			options.ownerUserID != "" {
			return fmt.Errorf("--request cannot be combined with source or planning flags")
		}
		return nil
	}

	if (options.file == "") == (options.directory == "") {
		return fmt.Errorf("pass exactly one of --file or --dir")
	}
	if batchSizeProvided && (options.batchSize < 1 || options.batchSize > 500) {
		return fmt.Errorf("--batch-size must be between 1 and 500")
	}
	if options.ownerUserID != "" && strings.TrimSpace(options.ownerUserID) != options.ownerUserID {
		return fmt.Errorf("--owner-user-id must not have surrounding whitespace")
	}

	if options.file != "" {
		if !validRecordsCLIIdentifier(options.objectAPIName) {
			return fmt.Errorf("--object must be a persisted records API identifier for --file")
		}
		if options.appID != "" && !validRecordsCLIIdentifier(options.appID) {
			return fmt.Errorf("--app must be a persisted records API identifier")
		}
		if options.duplicateKey != "" && !validRecordsCLIIdentifier(options.duplicateKey) {
			return fmt.Errorf("--duplicate-key must be a persisted records API identifier")
		}
		if options.label != "" || options.purpose != "" {
			return fmt.Errorf("--label and --purpose are only valid with --dir")
		}
		return nil
	}

	if !validRecordsCLIIdentifier(options.appID) {
		return fmt.Errorf("--app must be a persisted records API identifier for --dir")
	}
	if options.objectAPIName != "" || options.mappingFile != "" || options.duplicateKey != "" {
		return fmt.Errorf("--object, --mapping, and --duplicate-key are only valid with --file")
	}
	return nil
}

func validateRecordsImportSource(path string, directory bool) (string, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", fmt.Errorf("resolve import source: %w", err)
	}
	info, err := os.Lstat(absolute)
	if err != nil {
		return "", fmt.Errorf("inspect import source: %w", err)
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return "", fmt.Errorf("import source must not be a symbolic link")
	}
	if !directory {
		if !info.Mode().IsRegular() {
			return "", fmt.Errorf("--file must name a regular file")
		}
		if !strings.EqualFold(filepath.Ext(absolute), ".csv") {
			return "", fmt.Errorf("--file must name a .csv file")
		}
		if info.Size() > recordsImportMaxFileSize {
			return "", fmt.Errorf("CSV exceeds the 256 MiB import limit")
		}
		return absolute, nil
	}

	if !info.IsDir() {
		return "", fmt.Errorf("--dir must name a directory")
	}
	manifest := filepath.Join(absolute, "export-manifest.json")
	manifestInfo, err := os.Lstat(manifest)
	if err != nil || !manifestInfo.Mode().IsRegular() || manifestInfo.Mode()&os.ModeSymlink != 0 {
		return "", fmt.Errorf("artifact directory must contain a regular export-manifest.json")
	}
	var total int64
	err = filepath.WalkDir(absolute, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("artifact contains a symbolic link: %s", path)
		}
		if info.IsDir() {
			return nil
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("artifact contains a non-regular file: %s", path)
		}
		if info.Size() > recordsImportMaxFileSize {
			return fmt.Errorf("artifact file exceeds the 256 MiB per-file limit: %s", path)
		}
		total += info.Size()
		if total > recordsImportMaxDirSize {
			return fmt.Errorf("artifact directory exceeds the 1 GiB staging limit")
		}
		return nil
	})
	if err != nil {
		return "", err
	}
	return absolute, nil
}

func readRecordsImportMapping(path string) (map[string]*string, error) {
	if path == "" {
		return nil, nil
	}
	absolute, err := filepath.Abs(path)
	if err != nil {
		return nil, fmt.Errorf("resolve mapping file: %w", err)
	}
	info, err := os.Lstat(absolute)
	if err != nil {
		return nil, fmt.Errorf("inspect mapping file: %w", err)
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return nil, fmt.Errorf("--mapping must name a regular JSON file, not a symbolic link")
	}
	if info.Size() > 64<<10 {
		return nil, fmt.Errorf("mapping JSON exceeds 64 KiB")
	}
	bytes, err := os.ReadFile(absolute)
	if err != nil {
		return nil, fmt.Errorf("read mapping file: %w", err)
	}
	var mapping map[string]*string
	if err := json.Unmarshal(bytes, &mapping); err != nil || mapping == nil {
		return nil, fmt.Errorf("--mapping must contain a JSON object of column-to-field mappings")
	}
	for source, target := range mapping {
		if strings.TrimSpace(source) == "" || source != strings.TrimSpace(source) {
			return nil, fmt.Errorf("mapping source columns must be non-empty and have no surrounding whitespace")
		}
		if target != nil && (!validRecordsCLIIdentifier(*target) || *target != strings.TrimSpace(*target)) {
			return nil, fmt.Errorf("mapping target for %q must be a records API identifier or null", source)
		}
	}
	return mapping, nil
}

func newRecordsImportStageID() (string, error) {
	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err != nil {
		return "", fmt.Errorf("create import staging id: %w", err)
	}
	return hex.EncodeToString(bytes), nil
}

func validateRecordsImportContainerRoot(path string) (string, error) {
	clean := filepath.Clean(path)
	if !filepath.IsAbs(clean) || filepath.Base(clean) != "cli" || filepath.Base(filepath.Dir(clean)) != "imports" {
		return "", fmt.Errorf("worker returned an invalid records import staging path")
	}
	return clean, nil
}

func recordsWorkerAdminRequest(
	ctx context.Context,
	project string,
	files []string,
	method string,
	path string,
	body any,
	response any,
) error {
	args := []string{
		"exec", "-T", "worker", "curl", "--fail-with-body", "-sS",
		"-X", method,
	}
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("encode records import request: %w", err)
		}
		args = append(args, "-H", "Content-Type: application/json", "-d", string(encoded))
	}
	args = append(args, recordsImportAdminBaseURL+path)
	raw, err := composeCommandOutput(ctx, project, files, args...)
	if err != nil {
		return fmt.Errorf("records import worker request failed: %w", err)
	}
	if response != nil {
		if err := json.Unmarshal(raw, response); err != nil {
			return fmt.Errorf("parse records import worker response: %w", err)
		}
	}
	return nil
}

func stageRecordsImportSource(
	ctx context.Context,
	project string,
	files []string,
	containerRoot string,
	source string,
) (string, error) {
	stageID, err := newRecordsImportStageID()
	if err != nil {
		return "", err
	}
	stageDir := filepath.Join(containerRoot, stageID)
	if _, err := composeCommandOutput(ctx, project, files,
		"exec", "-T", "worker", "mkdir", "-m", "700", "-p", stageDir); err != nil {
		return "", fmt.Errorf("create records import staging directory: %w", err)
	}
	if _, err := composeCommandOutput(ctx, project, files,
		"cp", source, "worker:"+stageDir+"/"); err != nil {
		return "", fmt.Errorf("stage records import source: %w", err)
	}
	return filepath.ToSlash(filepath.Join("imports", "cli", stageID, filepath.Base(source))), nil
}

func recordsImportPrepareBody(options recordsImportOptions, sourcePath string, mapping map[string]*string) map[string]any {
	body := map[string]any{
		"sourcePath": sourcePath,
	}
	if options.file != "" {
		body["mode"] = "file"
		body["object"] = options.objectAPIName
		if options.appID != "" {
			body["app"] = options.appID
		}
		if mapping != nil {
			body["mapping"] = mapping
		}
		if options.duplicateKey != "" {
			body["duplicateKey"] = options.duplicateKey
		}
	} else {
		body["mode"] = "artifact"
		body["app"] = options.appID
		if options.label != "" {
			body["label"] = options.label
		}
		if options.purpose != "" {
			body["purpose"] = options.purpose
		}
	}
	if options.batchSizeSet || options.batchSize != 0 {
		body["batchSize"] = options.batchSize
	}
	if options.ownerUserID != "" {
		body["ownerUserId"] = options.ownerUserID
	}
	return body
}

func runRecordsImport(ctx context.Context, cmd *cobra.Command, options recordsImportOptions) error {
	if err := validateRecordsImportOptions(options); err != nil {
		return err
	}
	_, _, project, files, err := currentStackCompose()
	if err != nil {
		return err
	}
	if options.requestID != "" {
		return maybeStartRecordsImport(ctx, cmd, project, files, options.requestID, options.yes)
	}

	directory := options.directory != ""
	source := options.file
	if directory {
		source = options.directory
	}
	source, err = validateRecordsImportSource(source, directory)
	if err != nil {
		return err
	}
	mapping, err := readRecordsImportMapping(options.mappingFile)
	if err != nil {
		return err
	}
	var staging recordsImportStagingResponse
	if err := recordsWorkerAdminRequest(ctx, project, files, "GET", "/staging", nil, &staging); err != nil {
		return err
	}
	containerRoot, err := validateRecordsImportContainerRoot(staging.ContainerRoot)
	if err != nil {
		return err
	}
	stagedPath, err := stageRecordsImportSource(ctx, project, files, containerRoot, source)
	if err != nil {
		return err
	}
	var prepared recordsImportPreparedResponse
	if err := recordsWorkerAdminRequest(
		ctx,
		project,
		files,
		"POST",
		"/prepare",
		recordsImportPrepareBody(options, stagedPath, mapping),
		&prepared,
	); err != nil {
		return err
	}
	if prepared.Request.ID == "" || prepared.Request.Status != "pending_approval" {
		return fmt.Errorf("worker returned an invalid prepared records import request")
	}
	if err := writeRecordsImportPreview(cmd.OutOrStdout(), prepared.Request); err != nil {
		return err
	}
	return maybeStartRecordsImport(ctx, cmd, project, files, prepared.Request.ID, options.yes)
}

func maybeStartRecordsImport(
	ctx context.Context,
	cmd *cobra.Command,
	project string,
	files []string,
	requestID string,
	yes bool,
) error {
	start := yes
	if !start && prompt.IsInteractive() {
		answer, err := prompt.Visible("Start this import? [y/N] ")
		if err != nil {
			return err
		}
		start = strings.EqualFold(strings.TrimSpace(answer), "y") || strings.EqualFold(strings.TrimSpace(answer), "yes")
	}
	if !start {
		fmt.Fprintf(cmd.OutOrStdout(), "Prepared request %s; start later with openneko records import --request %s --yes\n", requestID, requestID)
		return nil
	}
	var started recordsImportStartResponse
	if err := recordsWorkerAdminRequest(
		ctx,
		project,
		files,
		"POST",
		"/start",
		map[string]string{"requestId": requestID},
		&started,
	); err != nil {
		return err
	}
	if started.RequestID != requestID || started.Status == "" {
		return fmt.Errorf("worker returned an invalid records import start response")
	}
	fmt.Fprintf(cmd.OutOrStdout(), "Import request %s is %s", started.RequestID, started.Status)
	if started.JobID != nil && *started.JobID != "" {
		fmt.Fprintf(cmd.OutOrStdout(), " as job %s", *started.JobID)
	}
	fmt.Fprintln(cmd.OutOrStdout(), ".")
	return nil
}

func writeRecordsImportPreview(out io.Writer, request recordsImportActionRequest) error {
	var payload recordsPreparedPayload
	if err := json.Unmarshal(request.Payload, &payload); err != nil {
		return fmt.Errorf("parse prepared import plan: %w", err)
	}
	fmt.Fprintf(out, "Prepared records import %s\n", terminalSafe(request.ID))
	switch request.Kind {
	case "records_import_start":
		if payload.ImportPlan == nil {
			return fmt.Errorf("prepared CSV import is missing its immutable plan")
		}
		writeRecordsCSVImportPreview(out, *payload.ImportPlan, "")
	case "records_artifact_import_start":
		if payload.ArtifactImportPlan == nil {
			return fmt.Errorf("prepared artifact import is missing its immutable plan")
		}
		plan := payload.ArtifactImportPlan
		fmt.Fprintf(out, "Target app: %s (%s)\n", terminalSafe(plan.Definition.AppID), terminalSafe(plan.Definition.Label))
		fmt.Fprintf(out, "Objects: %d\n", len(plan.Imports))
		for _, object := range plan.Imports {
			fmt.Fprintf(out, "  %s: %d rows from %s\n", terminalSafe(object.ObjectAPIName), object.RowCount, terminalSafe(object.Source.Name))
		}
		writeRecordsImportWarnings(out, plan.Warnings)
	default:
		return fmt.Errorf("worker prepared unexpected action kind %q", request.Kind)
	}
	return nil
}

func writeRecordsCSVImportPreview(out io.Writer, plan recordsCSVImportPlan, indent string) {
	fmt.Fprintf(out, "%sTarget: %s.%s\n", indent, terminalSafe(plan.AppID), terminalSafe(plan.ObjectAPIName))
	fmt.Fprintf(out, "%sSource: %s (%d rows, %d bytes)\n", indent, terminalSafe(plan.Source.Name), plan.RowCount, plan.Source.Bytes)
	fmt.Fprintf(out, "%sDuplicate key: %s; batch size: %d\n", indent, terminalSafe(plan.DuplicateKey), plan.BatchSize)
	fmt.Fprintf(out, "%sMapping:\n", indent)
	for _, column := range plan.Columns {
		target := "skip"
		if column.TargetField != nil {
			target = terminalSafe(*column.TargetField)
			if column.TargetKind != nil {
				target += " (" + terminalSafe(*column.TargetKind) + ")"
			}
		}
		fmt.Fprintf(out, "%s  %s -> %s\n", indent, terminalSafe(column.SourceColumn), target)
	}
	writeRecordsImportWarnings(out, plan.Warnings)
	if len(plan.SampleRows) > 0 {
		fmt.Fprintf(out, "%sSample rows:\n", indent)
		for index, row := range plan.SampleRows {
			parts := make([]string, 0, len(row))
			for _, column := range plan.Columns {
				if value, ok := row[column.SourceColumn]; ok {
					parts = append(parts, terminalSafe(column.SourceColumn)+"="+strconv.Quote(terminalSafe(value)))
				}
			}
			if len(parts) == 0 {
				keys := make([]string, 0, len(row))
				for key := range row {
					keys = append(keys, key)
				}
				sort.Strings(keys)
				for _, key := range keys {
					parts = append(parts, terminalSafe(key)+"="+strconv.Quote(terminalSafe(row[key])))
				}
			}
			fmt.Fprintf(out, "%s  %d. %s\n", indent, index+1, strings.Join(parts, ", "))
		}
	}
}

func writeRecordsImportWarnings(out io.Writer, warnings []string) {
	if len(warnings) == 0 {
		return
	}
	fmt.Fprintln(out, "Warnings:")
	for _, warning := range warnings {
		fmt.Fprintf(out, "  - %s\n", terminalSafe(warning))
	}
}

func terminalSafe(value string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return '�'
		}
		return r
	}, value)
}
