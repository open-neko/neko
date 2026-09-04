#!/usr/bin/env python3
"""Extract structured Markdown from a document using Docling.

Usage: extract_docling.py FILE [--max-chars=N]

Writes structured Markdown (headings, tables, reading order preserved) to
stdout. Exits 0 on success, non-zero with a reason on stderr when Docling
is unavailable or the file cannot be converted.

This is the OPT-IN high-fidelity extractor for the library distiller,
gated by NEKO_DOCLING_EXTRACTION=true on the Node side. It is intentionally
single-purpose: one document in, Markdown out. The caller (extract.ts)
computes section boundaries from the returned Markdown and falls back to
the bundled extract_text.py when this script fails for any reason, so a
missing `docling` install degrades gracefully instead of failing uploads.

Docling produces a unified document model spanning PDF (incl. scanned via
OCR), DOCX, PPTX, XLSX, and HTML, which is why one converter replaces the
whole degrade-by-format ladder in extract_text.py.
"""

import sys
from pathlib import Path


def fail(reason: str) -> "NoReturn":  # noqa: F821 - NoReturn is typing-only on 3.11
    print(reason, file=sys.stderr)
    sys.exit(1)


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    max_chars = 0
    for arg in sys.argv[1:]:
        if arg.startswith("--max-chars="):
            try:
                max_chars = int(arg.split("=", 1)[1])
            except ValueError:
                fail("--max-chars must be an integer")
    if len(args) != 1:
        fail("usage: extract_docling.py FILE [--max-chars=N]")
    path = Path(args[0])
    if not path.is_file():
        fail(f"not a file: {path}")

    try:
        from docling.document_converter import DocumentConverter  # type: ignore
    except ImportError:
        fail(
            "docling is not installed — `pip install docling` on the worker to "
            "enable high-fidelity extraction (NEKO_DOCLING_EXTRACTION=true)"
        )

    try:
        converter = DocumentConverter()
        result = converter.convert(str(path))
        markdown = result.document.export_to_markdown()
    except Exception as err:  # noqa: BLE001 - report any converter failure verbatim
        fail(f"docling conversion failed for {path.name}: {err}")

    if max_chars and max_chars > 0:
        markdown = markdown[:max_chars]
    sys.stdout.write(markdown)


if __name__ == "__main__":
    main()
