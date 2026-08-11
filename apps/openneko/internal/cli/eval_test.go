package cli

import (
	"bytes"
	"context"
	"io"
	"reflect"
	"testing"
)

func TestEvalForwardsArgumentsToWorkspaceRunner(t *testing.T) {
	previous := runEvalProcess
	t.Cleanup(func() { runEvalProcess = previous })
	var got []string
	runEvalProcess = func(
		_ context.Context,
		args []string,
		_ io.Writer,
		_ io.Writer,
	) (int, error) {
		got = append([]string(nil), args...)
		return 0, nil
	}

	root := NewRoot()
	var output bytes.Buffer
	root.SetOut(&output)
	root.SetErr(&output)
	root.SetArgs([]string{"eval", "plan", "--config", "evals/configs/smoke.yaml", "--json"})
	if err := root.Execute(); err != nil {
		t.Fatal(err)
	}
	want := []string{"plan", "--config", "evals/configs/smoke.yaml", "--json"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("forwarded args = %#v, want %#v", got, want)
	}
}

func TestEvalPreservesRunnerExitCode(t *testing.T) {
	previous := runEvalProcess
	t.Cleanup(func() { runEvalProcess = previous })
	runEvalProcess = func(
		_ context.Context,
		_ []string,
		_ io.Writer,
		_ io.Writer,
	) (int, error) {
		return 17, nil
	}

	root := NewRoot()
	root.SetArgs([]string{"eval", "validate", "--config", "bad.yaml"})
	err := root.Execute()
	if code := ExitCodeFor(err); code != 17 {
		t.Fatalf("exit code = %d, want 17 (err=%v)", code, err)
	}
}
