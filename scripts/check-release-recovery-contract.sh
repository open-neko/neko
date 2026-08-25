#!/usr/bin/env bash
# Fast static guard for the release recovery state machine. GitHub owns the
# workflow runtime, so this check ensures the source keeps the transitions that
# a failed-then-recovered stable release needs before Deploy-to-VM runs.
set -euo pipefail

release_workflow=".github/workflows/release-binaries.yml"
smoke_workflow=".github/workflows/post-release-smoke.yml"
budgets="scripts/image-size-budgets.json"

jq -e '
  .agent == 800
  and .uniqueStack == 1500
  and (.agent | type) == "number"
  and (.uniqueStack | type) == "number"
' "$budgets" >/dev/null

grep -Fq "Manual recovery runs may contain CI hardening newer than the tag" "$release_workflow"
grep -Fq "github.event_name == 'workflow_dispatch' && github.ref" "$release_workflow"
grep -Fq "Promote recovered stable release to \"Latest\" after smoke" "$smoke_workflow"
grep -Fq "success() && steps.ctx.outputs.stable == 'true' && steps.ctx.outputs.tag != ''" "$smoke_workflow"
grep -Fq -- "--prerelease=false --latest" "$smoke_workflow"
grep -Fq "failure() && steps.ctx.outputs.stable == 'true' && steps.ctx.outputs.tag != ''" "$smoke_workflow"
grep -Fq -- "--prerelease --latest=false" "$smoke_workflow"

echo "release recovery contract is intact"
