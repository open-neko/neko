# Document extraction and distillation

The Library turns accepted uploads into durable, searchable concepts.

## Accepted inputs

- Digital-text PDF, DOCX, PPTX, XLSX and CSV go through the owned librarian
  image.
- Markdown and plain text are decoded deterministically in the worker because
  agents can generate these files for OpenNeko to consume.
- JSON, HTML, TSV, images, legacy Office files, scanned documents and
  handwritten documents are outside the current product contract.

OCR is disabled. The librarian image contains only the Docling format support
and layout/table models required by this contract. Its dependency lock and
models are copied into the final image during release; model resolution is
forced offline and never downloads a model on first use. Release CI publishes
the owned multi-architecture image by digest and embeds the release manifest
digest in the OpenNeko CLI, which supplies Compose with a
`:<release>@sha256:...` ref.

## Durable pipeline

```text
upload
  -> library_extract pg-boss job
     -> direct text, or submit/poll the librarian async API
     -> hash and atomically store temporary normalized Markdown
  -> library_distill pg-boss job
     -> chunk all extracted text on headings
     -> map every chunk to validated neko_library upserts
     -> reduce repeated concept paths
     -> upsert concepts
```

The extraction task ID is checkpointed in Postgres. A worker restart resumes
polling; a librarian restart returns `404`, which makes the worker resubmit the
same immutable source. The temporary Markdown is content-addressed beneath the
org workspace at `library/derived/<document>/<extractor>/<content>.md`.

Every distillation chunk must return at least one valid upsert. Empty,
malformed, or skip-only output fails the chunk. Multi-chunk checkpoints bind
the cursor and accumulated operations to the source hash, extractor
fingerprint, extracted-content hash and chunk-plan hash, so a retry resumes
without accepting stale state or rebilling completed chunks.

Derived Markdown and checkpoints are deleted after successful cataloging.
The row keeps its artifact pointer until the deletion completes, so a worker
restart can finish cleanup instead of leaking an untracked file.
Failures retain them for diagnosis and retry for seven days; the worker sweep
then removes them. Compact extraction hashes and the extractor fingerprint
remain on the document row as provenance.

## Storage lifecycle

- The original upload is durable because concept citations point to it.
  Direct Library imports live at
  `library/uploads/<owner>/<source-hash>/<filename>` until the owner removes
  the Library document. Work attachments live at `uploads/<thread>/<filename>`
  and follow the thread lifecycle.
- The librarian's input copy and normalized result live only in its bounded
  `/tmp` tmpfs. One converter and one pending-task slot provide backpressure.
  The input is removed before the result is spooled; the result is removed when
  the worker retrieves it, with a 15-minute expiry as a fallback.
- Normalized Markdown needed across worker restarts lives temporarily at
  `library/derived/<document>/<extractor>/<content>.md` in the org workspace.
  The matching extraction and distillation checkpoints live on the
  `library_document` row in Postgres.
- Successful jobs remove that Markdown and both checkpoints immediately.
  Failed jobs retain retry state for seven days, after which the periodic and
  boot-time sweeper removes it. Source/extraction hashes, the extractor
  fingerprint and completion timestamps remain as compact provenance.
