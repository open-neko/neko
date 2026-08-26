# OpenNeko agent MCP runtime

This package owns the runtime contract between Hermes, OpenNeko's sandbox
bridge, the trusted worker control plane, GraphJin, and the A2UI renderer.

## GraphJin MCP

OpenNeko does not maintain a GraphJin tool allow-list or duplicate GraphJin's
tool schemas. At the start of each agent turn, the sandbox bridge asks the
trusted control plane for the configured GraphJin server's live `tools/list`
response. Every returned tool and its native JSON schema is exposed through the
higher-level `neko_graphjin` MCP. Calls route back as native `tools/call`
requests and their MCP results are returned unchanged.

GraphJin's current Streamable HTTP contract is stateless, so OpenNeko sends
`tools/list` and `tools/call` directly without `initialize`. Every request
carries GraphJin 3.20's `2026-07-28` protocol header, method header, and
per-request client metadata so it cannot fall into the legacy session path. The
client follows list cursors and accepts JSON or SSE responses.

The sandbox receives neither `data_source.mcp_url` nor a GraphJin credential.
The broker binds the organization and run, mints the actor or service JWT on the
trusted host, and treats GraphJin's caller-aware tool list and capability gates
as authoritative. The physical `neko` multiplexer changes only tool-name
prefixes; descriptions, annotations, and input/output schemas survive intact.

## A2UI rendering

A web turn mounts one logical server, `neko_ui`, with one tool,
`render_cards`. Its canonical Hermes ACP title is
`mcp_neko_ui_render_cards`. There is no separate Hermes render stub or live
fence path; the brokered server validates the call and solely emits the
surface.

[`src/work/a2ui-contract.ts`](src/work/a2ui-contract.ts) is the source of truth
for the names, A2UI identifiers, Zod validator, and the JSON Schema generated
from that validator. Persisted A2UI v0.9 messages retain reader-only
compatibility.

The accepted envelope is:

```json
{
  "messages": [
    {
      "version": "v1.0",
      "createSurface": {
        "surfaceId": "answer-unique-id",
        "catalogId": "urn:openneko:catalog:work:v2",
        "components": [
          { "id": "root", "component": "Answer", "children": [] }
        ]
      }
    }
  ]
}
```

Accepted calls remain visually quiet because the surface is the answer.
Rejected calls emit a correlated `tool_start` containing the exact `rawInput`,
canonical title, and validation issues, followed by `tool_end`. This preserves
diagnostic evidence without showing successful render-tool pills.

## Regression invariants

Tests cover future/unknown GraphJin tools across both broker hops, native schema
and result preservation, the no-`initialize` contract, one canonical render
server/tool, generated-schema validation, one surface emission for valid calls,
and exact rejected render input in telemetry.
