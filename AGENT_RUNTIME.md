# Agent runtime artifact contract

OpenNeko packages the untrusted agent loop as the private
`@neko/agent-runtime` workspace package. Its build output is the complete
filesystem contract copied into the `openneko/agent` image. Docker does not
maintain a second allowlist of individual runtime files.

This preserves the security boundary introduced by the slim agent image: the
agent receives the executable bundles and declared read-only assets it needs,
but no worker source tree, database driver, secret implementation, telemetry
implementation, or workspace `node_modules` closure.

## Artifact layout

`pnpm --filter @neko/agent-runtime build` creates
`packages/agent-runtime/dist/`:

```text
agent-entry.js
mcp-bridge.js
assets/builtin-skills/...
tool-output/compact-cli.mjs
agent-runtime-manifest.json
```

The generated manifest is authoritative. It declares the file or directory
for each runtime role, the clean-environment defaults owned by the runtime, and
the SHA-256 digest of every shipped file. At startup, the entrypoint resolves
all paths from that manifest and exports the paths needed by Hermes and the
GraphJin guard. It does not infer undeclared files from a source-workspace
layout.

## Preflight guarantees

`node /app/agent-entry.js --preflight` verifies:

1. The artifact contains exactly the files declared by the manifest.
2. Every file matches its declared digest and every role exists. Artifact
   directories are normalized to read-only, world-traversable permissions and
   files to read-only, world-readable permissions.
3. Built-in skills can be materialized into a run workspace.
4. Every supported logical MCP server can be constructed by the shipped bridge.
5. The GraphJin guard can stage the manifest-owned compact CLI and rejects
   direct data-source access inside the sandbox.

The package test suite runs this preflight with a clean environment. The final
Docker stage runs it as the unprivileged `sandbox` user during the image build,
and PR CI builds the final agent image and runs it again. Release smoke tests
therefore exercise the same filesystem identity and contract used by OpenShell
sandbox creation.

## Turn protocol guarantees

The tagged stdout protocol is ordered and lossless at the process boundary:

1. Agent events are delivered to the host serially in marker order.
2. The launcher drains every event handler before accepting the result marker.
3. A `completed` result must contain assistant output or be accompanied by a
   user-visible surface event. A content-free ACP `end_turn` is retried only
   when no tool activity occurred; if it repeats, the run fails with an
   explicit diagnostic instead of persisting an empty success.

These guarantees are behavioral parts of the runtime artifact contract. Keep
the delayed-event, empty-completion, and surface-only regression tests when
changing the bundle, launcher, backend, or stdout protocol.

## GraphJin protocol contract

Sandboxed chat, workflow, profiler, metric, and job agents read customer data
through `mcp__neko_graphjin__execute_graphql`. The packaged MCP bridge sends the
request to the run-bound host broker. The host selects the source, resolves the
work-run actor, mints a short-lived actor token for that call, rejects mutations
and subscriptions, and performs the GraphQL request.

The source URL, actor token, signing material, native GraphJin binary, and direct
data-source egress never enter the sandbox. A manifest-owned deny shim gives
legacy skill instructions an explicit migration error, so an obsolete
independently versioned client initialization state machine cannot break ask
runs or become a policy bypass. Tests cover prompt routing, chat/workflow server
mounting, bridge construction, broker org/run binding, and the image preflight
denial.

## Changing runtime dependencies

When sandbox code starts reading a new filesystem resource, add it to
`packages/agent-runtime/scripts/build.mjs` and give it a named manifest role if
runtime code addresses it directly. Then extend the preflight to exercise the
consumer. Do not add a one-off `COPY` to the Dockerfile: Docker copies the whole
generated artifact as one unit.

Runtime JavaScript belongs under `packages/agent-runtime/src/`. Host broker
implementations and anything with database, records, secrets, or telemetry
access stay outside the package. The build fails if either bundle pulls those
control-plane dependencies across the boundary.

## Local verification

```sh
pnpm --filter @neko/agent-runtime typecheck
pnpm --filter @neko/agent-runtime test
docker build --target agent -t openneko/agent:contract-test .
docker run --rm --user 1000660000:1000660000 --entrypoint node \
  openneko/agent:contract-test \
  /app/agent-entry.js --preflight
```
