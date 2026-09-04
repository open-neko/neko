# syntax=docker/dockerfile:1.7

FROM python:3.12.11-slim-bookworm@sha256:519591d6871b7bc437060736b9f7456b8731f1499a57e22e6c285135ae657bf7 AS dependencies

ENV UV_LINK_MODE=copy

WORKDIR /app
RUN --mount=type=cache,target=/root/.cache/pip pip install uv==0.8.15
COPY apps/librarian/pyproject.toml apps/librarian/uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv uv sync --frozen --no-dev

FROM dependencies AS librarian-test
RUN --mount=type=cache,target=/root/.cache/uv uv sync --frozen
COPY apps/librarian/app.py apps/librarian/test_app.py ./
RUN uv run pytest -q test_app.py

FROM dependencies AS model-builder
RUN --mount=type=cache,target=/root/.cache/huggingface .venv/bin/python - <<'PY'
from huggingface_hub import snapshot_download

snapshot_download(
    repo_id="docling-project/docling-layout-heron",
    revision="8f39ad3c0b4c58e9c2d2c84a38465abf757272d8",
    local_dir="/opt/docling/models/docling-project--docling-layout-heron",
)
snapshot_download(
    repo_id="docling-project/docling-models",
    revision="fc0f2d45e2218ea24bce5045f58a389aed16dc23",
    allow_patterns=["config.json", "model_artifacts/tableformer/accurate/*"],
    local_dir="/opt/docling/models/docling-project--docling-models",
)
PY
RUN find /app/.venv -type d -name __pycache__ -prune -exec rm -rf '{}' + \
 && find /app/.venv -type d \( -name test -o -name tests \) -prune -exec rm -rf '{}' + \
 && rm -rf /app/.venv/lib/python3.12/site-packages/torch/include \
 && find /opt/docling/models -type d -name .cache -prune -exec rm -rf '{}' +

FROM python:3.12.11-slim-bookworm@sha256:519591d6871b7bc437060736b9f7456b8731f1499a57e22e6c285135ae657bf7 AS librarian

ENV DOCLING_ARTIFACTS_PATH=/opt/docling/models \
    HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1 \
    UVICORN_HOST=0.0.0.0 \
    UVICORN_PORT=5001 \
    PYTHONUNBUFFERED=1 \
    PATH=/app/.venv/bin:$PATH

LABEL org.openneko.librarian.docling-slim="2.124.0" \
      org.openneko.librarian.layout-revision="8f39ad3c0b4c58e9c2d2c84a38465abf757272d8" \
      org.openneko.librarian.tableformer-revision="fc0f2d45e2218ea24bce5045f58a389aed16dc23" \
      org.openneko.librarian.ocr="disabled"

RUN useradd --create-home --uid 10001 librarian
WORKDIR /app
COPY --from=model-builder --chown=librarian:librarian /app/.venv /app/.venv
COPY --from=model-builder --chown=librarian:librarian /opt/docling/models /opt/docling/models
COPY --chown=librarian:librarian apps/librarian/app.py /app/app.py

USER librarian
EXPOSE 5001
CMD ["uvicorn", "app:app"]
