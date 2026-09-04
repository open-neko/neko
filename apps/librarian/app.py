"""OpenNeko's small, offline Docling extraction service.

Only digital-text PDF, DOCX, PPTX, XLSX and CSV are accepted. OCR is disabled
by construction. Task state is intentionally disposable: OpenNeko persists the
task id and resubmits after this container restarts.
"""

from __future__ import annotations

import asyncio
import os
import shutil
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Literal
from uuid import uuid4

from fastapi import FastAPI, File, Form, HTTPException, UploadFile, status
from fastapi.responses import JSONResponse

TaskState = Literal["pending", "started", "success", "failure"]
SUPPORTED = {"pdf", "docx", "pptx", "xlsx", "csv"}
TASK_ROOT = Path(os.environ.get("NEKO_LIBRARIAN_TASK_ROOT", "/tmp/neko-librarian"))
MODEL_ROOT = Path(os.environ.get("DOCLING_ARTIFACTS_PATH", "/opt/docling/models"))
REQUIRED_MODEL_FILES = (
    "docling-project--docling-layout-heron/config.json",
    "docling-project--docling-layout-heron/model.safetensors",
    "docling-project--docling-layout-heron/preprocessor_config.json",
    "docling-project--docling-models/model_artifacts/tableformer/accurate/tableformer_accurate.safetensors",
    "docling-project--docling-models/model_artifacts/tableformer/accurate/tm_config.json",
)
MAX_UPLOAD_BYTES = 100 * 1024 * 1024
RESULT_RETENTION_SECONDS = 15 * 60
MAX_PENDING_TASKS = 1


@dataclass
class Task:
    task_id: str
    source: Path
    input_format: str
    state: TaskState = "pending"
    result_path: Path | None = None
    error: str | None = None
    created_at: float = field(default_factory=time.monotonic)
    completed_at: float | None = None


tasks: dict[str, Task] = {}
queue: asyncio.Queue[str] = asyncio.Queue(maxsize=MAX_PENDING_TASKS)
worker_task: asyncio.Task[None] | None = None


@asynccontextmanager
async def lifespan(_: FastAPI):
    global queue, worker_task
    TASK_ROOT.mkdir(parents=True, exist_ok=True)
    queue = asyncio.Queue(maxsize=MAX_PENDING_TASKS)
    tasks.clear()
    worker_task = asyncio.create_task(_conversion_worker())
    try:
        yield
    finally:
        worker_task.cancel()
        await asyncio.gather(worker_task, return_exceptions=True)
        shutil.rmtree(TASK_ROOT, ignore_errors=True)
        tasks.clear()


app = FastAPI(
    title="Neko Librarian",
    version="1",
    docs_url=None,
    redoc_url=None,
    lifespan=lifespan,
)


@app.get("/health/ready")
async def ready() -> dict[str, object]:
    models_ready = all((MODEL_ROOT / path).is_file() for path in REQUIRED_MODEL_FILES)
    if worker_task is None or worker_task.done() or not models_ready:
        raise HTTPException(status_code=503, detail="librarian is not ready")
    return {
        "ok": True,
        "ocr": False,
        "formats": sorted(SUPPORTED),
        "queue_depth": queue.qsize(),
    }


@app.post("/v1/convert/file/async", status_code=status.HTTP_202_ACCEPTED)
async def convert_file_async(
    files: list[UploadFile] = File(...),
    from_formats: list[str] = Form(...),
    do_ocr: bool = Form(False),
) -> dict[str, object]:
    _expire_results()
    if len(files) != 1:
        raise HTTPException(status_code=400, detail="exactly one file is required")
    if do_ocr:
        raise HTTPException(status_code=400, detail="OCR is not supported")
    upload = files[0]
    supplied_format = from_formats[0].lower() if from_formats else ""
    extension = Path(upload.filename or "").suffix.lower().lstrip(".")
    if extension not in SUPPORTED or supplied_format != extension:
        raise HTTPException(status_code=415, detail="unsupported or mismatched file format")
    if queue.full():
        raise HTTPException(status_code=429, detail="conversion queue is full")

    task_id = str(uuid4())
    task_dir = TASK_ROOT / task_id
    task_dir.mkdir(parents=True, exist_ok=False)
    source = task_dir / f"source.{extension}"
    written = 0
    try:
        with source.open("wb") as target:
            while chunk := await upload.read(1024 * 1024):
                written += len(chunk)
                if written > MAX_UPLOAD_BYTES:
                    raise HTTPException(status_code=413, detail="file exceeds 100 MB")
                target.write(chunk)
    except Exception:
        shutil.rmtree(task_dir, ignore_errors=True)
        raise
    finally:
        await upload.close()
    if written == 0:
        shutil.rmtree(task_dir, ignore_errors=True)
        raise HTTPException(status_code=400, detail="file is empty")

    tasks[task_id] = Task(task_id=task_id, source=source, input_format=extension)
    await queue.put(task_id)
    return {"task_id": task_id, "task_status": "pending", "task_position": queue.qsize()}


@app.get("/v1/status/poll/{task_id}")
async def poll(task_id: str) -> dict[str, object]:
    _expire_results()
    task = tasks.get(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="task not found")
    return {
        "task_id": task_id,
        "task_status": task.state,
        "error_message": task.error,
    }


@app.get("/v1/result/{task_id}")
async def result(task_id: str) -> JSONResponse:
    _expire_results()
    task = tasks.get(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="task not found")
    if task.state in {"pending", "started"}:
        return JSONResponse(
            status_code=202,
            content={"status": task.state, "document": None, "errors": []},
        )
    if task.state == "failure":
        return JSONResponse(
            content={
                "status": "failure",
                "document": None,
                "errors": [{"error_message": task.error or "conversion failed"}],
            }
        )
    if task.result_path is None or not task.result_path.is_file():
        raise HTTPException(status_code=503, detail="conversion result is unavailable")
    markdown = await asyncio.to_thread(task.result_path.read_text, encoding="utf-8")
    tasks.pop(task_id, None)
    shutil.rmtree(task.source.parent, ignore_errors=True)
    return JSONResponse(
        content={
            "status": "success",
            "document": {"md_content": markdown},
            "errors": [],
        }
    )


async def _conversion_worker() -> None:
    while True:
        task_id = await queue.get()
        task = tasks.get(task_id)
        if task is None:
            queue.task_done()
            continue
        task.state = "started"
        try:
            markdown = await asyncio.to_thread(_convert, task.source)
            if not markdown.strip():
                raise ValueError(
                    "No embedded text was found. Scanned and handwritten documents are not supported yet."
                )
            # Release the input before spooling the result so the bounded tmpfs
            # does not need to hold both complete copies at the same time.
            task.source.unlink(missing_ok=True)
            task.result_path = task.source.parent / "result.md"
            await asyncio.to_thread(
                task.result_path.write_text,
                markdown,
                encoding="utf-8",
            )
            task.state = "success"
        except Exception as exc:  # surfaced through the result contract
            task.state = "failure"
            task.error = str(exc)[:2_000]
        finally:
            task.completed_at = time.monotonic()
            task.source.unlink(missing_ok=True)
            if task.state == "failure":
                shutil.rmtree(task.source.parent, ignore_errors=True)
            queue.task_done()


def _convert(source: Path) -> str:
    # Imports stay inside the worker thread so startup/health remains fast.
    converter = _converter()
    converted = converter.convert(source, raises_on_error=True)
    if not _document_has_embedded_text(converted.document):
        raise ValueError(
            "No embedded text was found. Scanned and handwritten documents are not supported yet."
        )
    return converted.document.export_to_markdown()


def _document_has_embedded_text(document) -> bool:
    """Reject image/handwriting-only output without mistaking placeholders for text."""
    for item, _level in document.iterate_items():
        label = str(getattr(item, "label", "")).lower()
        if "handwritten" in label:
            continue
        text = getattr(item, "text", None)
        if isinstance(text, str) and any(char.isalnum() for char in text):
            return True
        data = getattr(item, "data", None)
        for cell in getattr(data, "table_cells", ()):
            cell_text = getattr(cell, "text", None)
            if isinstance(cell_text, str) and any(char.isalnum() for char in cell_text):
                return True
    return False


@lru_cache(maxsize=1)
def _converter():
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions
    from docling.document_converter import DocumentConverter, PdfFormatOption

    pdf_options = PdfPipelineOptions()
    pdf_options.do_ocr = False
    pdf_options.do_table_structure = True
    pdf_options.generate_page_images = False
    pdf_options.generate_picture_images = False
    pdf_options.artifacts_path = MODEL_ROOT
    return DocumentConverter(
        allowed_formats=[
            InputFormat.PDF,
            InputFormat.DOCX,
            InputFormat.PPTX,
            InputFormat.XLSX,
            InputFormat.CSV,
        ],
        format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=pdf_options)},
    )


def _expire_results() -> None:
    now = time.monotonic()
    expired = [
        task_id
        for task_id, task in tasks.items()
        if task.completed_at is not None
        and now - task.completed_at > RESULT_RETENTION_SECONDS
    ]
    for task_id in expired:
        task = tasks.pop(task_id, None)
        if task is not None:
            shutil.rmtree(task.source.parent, ignore_errors=True)
