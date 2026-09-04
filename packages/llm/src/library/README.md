# The document library: extraction & distillation

This package turns an uploaded document into durable, searchable **concepts**
in the knowledge library. This note explains *why* the pipeline is shaped the
way it is — the intent behind the moving parts — so the code reads as a set of
deliberate decisions rather than accidents.

## The pipeline

```
upload
  → librarian service (Docling)        extract.ts   → structured Markdown + heading sections
  → outline-then-zoom                  outline.ts   → pick knowledge-bearing sections
  → chunk on headings                  chunk.ts     → windows under a per-chunk budget
  → map: distill each chunk            distill.ts   → neko_library ops (threaded with prior concepts)
  → reduce: merge ops by path          distill.ts   → one concept per path, bodies combined
  → upsert concepts                    work/library.ts
        ↑ checkpointed after every chunk (resumable on retry)
```

## Intent, decision by decision

### Extraction is a dedicated service, not in the worker

High-fidelity extraction (Docling) carries a heavy stack — Torch plus layout
and OCR models — and its memory/CPU cost is spiky (a 300-page scanned PDF is a
very different load than a one-page memo). The worker already runs watchers,
actions, channels, and the sandbox broker; that stack has no business sharing
its process. So extraction runs as its own container — Docling's official
`docling-serve` image, the `librarian` service in `compose.yml` — and the
worker calls it over HTTP (`NEKO_LIBRARIAN_URL`), exactly as it calls GraphJin.
The heavy dependency is isolated, scaled, and crash-contained on its own.

This mirrors how the codebase already isolates OpenShell and the GraphJin agent
as separate containers rather than worker responsibilities.

### There is exactly one extractor — no fallback

The librarian service is the **only** extractor. There is no in-process
"slim" extractor to fall back to. If the service is unreachable or a
conversion fails, extraction fails with a clear reason, the document row is
marked failed, and it is retryable from `/library`. We never silently degrade
to lower-fidelity text and catalog a worse version of the document — a quiet
downgrade is worse than a loud failure a human can retry.

(The bundled `document-extraction` skill / `extract_text.py` still exists, but
only as the *agent's* in-sandbox tool — a separate consumer with no network
path to the service. It is not a library fallback.)

### Structured Markdown, so chunking is meaningful

Docling returns Markdown with headings, tables, and reading order preserved,
and `extract.ts` derives a **section map** (`ExtractedSection[]`) from it. That
structure is the enabling detail for everything downstream: the distiller can
split a document on *natural* boundaries (headings) instead of raw character
offsets, and record provenance per section.

### Distill the whole document, in a map-reduce

The old distiller truncated to the first 60k characters — a hundred-page
contract was cataloged from its first ~25 pages. Now the whole document is
distilled:

- **Map** — each chunk is distilled independently, but is shown the concepts
  already extracted from *earlier chunks of the same document*. That is what
  makes "update, don't duplicate" work **across** parts, not just across
  re-uploads: a concept that spans a chunk boundary is continued, not
  duplicated.
- **Reduce** — ops are merged **by concept path** before writing. Two chunks
  that both touch `contracts/acme-msa.md` are combined (bodies concatenated,
  tags unioned, earliest expiry kept) into a single upsert. This is the
  critical correctness point: `upsertLibraryConcept` *replaces* a concept in
  place, so a naive per-chunk upsert would have the last chunk clobber the
  first. Reduce-by-path is what prevents that.

### Outline-then-zoom keeps cost proportional to signal

A large document is mostly not knowledge — tables of contents, raw-data
appendices, exhibits, signature blocks. Distilling every chunk of it in full
is wasteful. So for multi-chunk documents, one cheap pass over the section
outline (heading + size + a lead snippet) selects the knowledge-bearing
sections, and only those are distilled in full.

The selection can only **narrow**. If the outline reply is unparseable or
empty, the pipeline distills everything. Outlining is a cost optimization that
can never drop content — only skip spending on sections that carry none.

### Per-chunk checkpointing makes large jobs resumable

A sixty-chunk document that dies on chunk forty should not re-bill forty LLM
calls on retry. After each chunk, the distiller persists a checkpoint
(`library_document.distill_checkpoint`): the outline selection, the chunk
count, the cursor, and the merged ops so far. A retry validates the checkpoint
against the current extraction (a drifted plan is discarded and restarted) and
**resumes from the next chunk**.

The checkpoint is kept on failure and cleared on success or skip. It is honored
even under `force` — the operator retry route forces to bypass triage, but
there is no reason for that to re-bill chunks a checkpoint already covers;
`force` re-catalogs and skips the outline pass, not the resume.

## What is not yet done

- **Live verification.** The Docling round-trip and the `0068` migration are
  exercised in unit tests against mocks; they still need one real
  `docker compose up librarian` and a migration run to confirm end to end.
- **A truly-fresh forced redo.** `force` resumes a checkpoint rather than
  discarding it; there is no "start this document over from scratch" action
  distinct from retry. The plan-drift guard covers a re-extracted document,
  but a deliberate full redo is not exposed.
- **Outline cost tuning.** The outline pass currently runs for any multi-chunk
  document; a size threshold could skip it when the whole document is small
  enough that one extra call is not worth it.
