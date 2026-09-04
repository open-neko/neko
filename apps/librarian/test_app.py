import time
from types import SimpleNamespace

from fastapi.testclient import TestClient

import app as librarian


def test_readiness_requires_every_vendored_model(tmp_path, monkeypatch):
    task_root = tmp_path / "tasks"
    model_root = tmp_path / "models"
    model_root.mkdir()
    monkeypatch.setattr(librarian, "TASK_ROOT", task_root)
    monkeypatch.setattr(librarian, "MODEL_ROOT", model_root)
    with TestClient(librarian.app) as client:
        assert librarian.queue.maxsize == 1
        assert client.get("/health/ready").status_code == 503
        for relative_path in librarian.REQUIRED_MODEL_FILES:
            path = model_root / relative_path
            path.parent.mkdir(parents=True, exist_ok=True)
            path.touch()
        response = client.get("/health/ready")
        assert response.status_code == 200
        assert response.json()["ocr"] is False


def test_rejects_ocr_requests(tmp_path, monkeypatch):
    monkeypatch.setattr(librarian, "TASK_ROOT", tmp_path)
    with TestClient(librarian.app) as client:
        response = client.post(
            "/v1/convert/file/async",
            files={"files": ("digital.pdf", b"%PDF-1.4", "application/pdf")},
            data={"from_formats": "pdf", "do_ocr": "true"},
        )
    assert response.status_code == 400
    assert response.json()["detail"] == "OCR is not supported"


def test_rejects_formats_outside_the_product_contract(tmp_path, monkeypatch):
    monkeypatch.setattr(librarian, "TASK_ROOT", tmp_path)
    with TestClient(librarian.app) as client:
        response = client.post(
            "/v1/convert/file/async",
            files={"files": ("page.html", b"<p>no</p>", "text/html")},
            data={"from_formats": "html", "do_ocr": "false"},
        )
    assert response.status_code == 415


def test_async_result_contract(tmp_path, monkeypatch):
    monkeypatch.setattr(librarian, "TASK_ROOT", tmp_path)
    monkeypatch.setattr(librarian, "_convert", lambda _source: "# Digital policy\n\nText")
    with TestClient(librarian.app) as client:
        submitted = client.post(
            "/v1/convert/file/async",
            files={"files": ("digital.pdf", b"%PDF-1.4", "application/pdf")},
            data={"from_formats": "pdf", "do_ocr": "false"},
        )
        assert submitted.status_code == 202
        task_id = submitted.json()["task_id"]
        for _ in range(50):
            polled = client.get(f"/v1/status/poll/{task_id}").json()
            if polled["task_status"] == "success":
                break
            time.sleep(0.01)
        assert polled["task_status"] == "success"
        result = client.get(f"/v1/result/{task_id}")
        assert result.status_code == 200
        assert result.json()["document"]["md_content"].startswith("# Digital")
        assert client.get(f"/v1/status/poll/{task_id}").status_code == 404


def test_embedded_text_gate_rejects_picture_and_handwriting_only_documents():
    picture = SimpleNamespace(label="picture")
    handwriting = SimpleNamespace(label="handwritten_text", text="written by hand")
    document = SimpleNamespace(iterate_items=lambda: iter([(picture, 0), (handwriting, 0)]))
    assert librarian._document_has_embedded_text(document) is False


def test_embedded_text_gate_accepts_digital_paragraphs_and_tables():
    paragraph = SimpleNamespace(label="paragraph", text="Digital policy text")
    paragraph_document = SimpleNamespace(iterate_items=lambda: iter([(paragraph, 0)]))
    assert librarian._document_has_embedded_text(paragraph_document) is True

    cell = SimpleNamespace(text="420000")
    table = SimpleNamespace(label="table", data=SimpleNamespace(table_cells=[cell]))
    table_document = SimpleNamespace(iterate_items=lambda: iter([(table, 0)]))
    assert librarian._document_has_embedded_text(table_document) is True
import time
