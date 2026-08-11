#!/usr/bin/env bash
# Install the three external CLIs Neko's worker shells out to:
#   - graphjin  (always required; the metric agent runs `graphjin cli`)
#   - claude    (only for the Claude Agent backend; the SDK spawns it)
#   - hermes    (only for the Hermes backend; same — spawned, not bundled)
#
# Idempotent. Pass --skip-claude or --skip-hermes if you only need one
# backend. macOS uses Homebrew where possible; Debian/Ubuntu uses apt +
# direct installers. Other distros: read the body and adapt.
#
# Usage:
#   ./scripts/install-clis.sh                # install all three
#   ./scripts/install-clis.sh --skip-hermes  # graphjin + claude only
set -euo pipefail

GRAPHJIN_VERSION="${GRAPHJIN_VERSION:-3.18.42}"
# Pin Hermes to the same ref baked into the Dockerfile so local-dev installs
# match what ships in the container image. v2026.8.3 / v0.20.0.
HERMES_AGENT_REF="${HERMES_AGENT_REF:-3c27eb6234bf91b8ceee9e9071591b31e9b148cb}"
HERMES_AGENT_INSTALL_DIR="${HERMES_AGENT_INSTALL_DIR:-${HERMES_HOME:-$HOME/.hermes}/hermes-agent}"
HERMES_UV_INSTALL_DIR="${HERMES_UV_INSTALL_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/openneko/uv}"

SKIP_GRAPHJIN=false
SKIP_CLAUDE=false
SKIP_HERMES=false
for arg in "$@"; do
  case "$arg" in
    --skip-graphjin) SKIP_GRAPHJIN=true ;;
    --skip-claude)   SKIP_CLAUDE=true ;;
    --skip-hermes)   SKIP_HERMES=true ;;
    -h|--help)
      sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

log() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

# Hermes v0.20's uv configuration requires the newer resolver/config parser.
# uv 0.4 (still common in older Homebrew installations) ignores part of the
# project config and cannot resolve the locked environment.
uv_supports_hermes() {
  uv_candidate="$1"
  [ -x "$uv_candidate" ] || return 1
  uv_version="$("$uv_candidate" --version 2>/dev/null | awk '{print $2}')"
  uv_major="${uv_version%%.*}"
  uv_remainder="${uv_version#*.}"
  uv_minor="${uv_remainder%%.*}"
  case "$uv_major:$uv_minor" in
    *[!0-9:]*|:|*:)
      return 1
      ;;
  esac
  [ "$uv_major" -gt 0 ] || [ "$uv_minor" -ge 12 ]
}

uname_s=$(uname -s)
case "$uname_s" in
  Darwin) os=macos ;;
  Linux)  os=linux ;;
  *) echo "unsupported OS: $uname_s" >&2; exit 1 ;;
esac

# ─── graphjin ──────────────────────────────────────────────────────────
if ! $SKIP_GRAPHJIN && ! have graphjin; then
  log "installing graphjin v${GRAPHJIN_VERSION}"
  if [ "$os" = macos ] && have brew; then
    brew install dosco/tap/graphjin
  else
    arch=$(uname -m)
    case "$arch" in
      x86_64|amd64) gj_arch=amd64 ;;
      aarch64|arm64) gj_arch=arm64 ;;
      *) echo "unsupported arch for graphjin: $arch" >&2; exit 1 ;;
    esac
    suffix="${os}_${gj_arch}"
    [ "$os" = macos ] && suffix="darwin_${gj_arch}"
    tmp=$(mktemp -d)
    curl -fsSL -o "$tmp/gj.tgz" \
      "https://github.com/dosco/graphjin/releases/download/v${GRAPHJIN_VERSION}/graphjin_${GRAPHJIN_VERSION}_${suffix}.tar.gz"
    sudo tar -xzf "$tmp/gj.tgz" -C /usr/local/bin graphjin
    rm -rf "$tmp"
  fi
  graphjin version
fi

# ─── claude (Claude Code CLI) ──────────────────────────────────────────
if ! $SKIP_CLAUDE && ! have claude; then
  if ! have npm; then
    echo "claude install requires npm. Install Node 18+ first (https://nodejs.org)." >&2
    exit 1
  fi
  log "installing @anthropic-ai/claude-code globally via npm"
  if [ -w "$(npm root -g 2>/dev/null || echo /)" ]; then
    npm install -g @anthropic-ai/claude-code
  else
    sudo npm install -g @anthropic-ai/claude-code
  fi
fi

# ─── hermes (Nous Research) ────────────────────────────────────────────
# Hermes is a Python tool installed from its source checkout via uv. Needs
# Python 3.11+ + git. v0.20+ refuses wheel builds, so keep the exact checkout
# and use its locked editable environment, matching the supported upstream
# install model and the Dockerfile. Do not accept an arbitrary existing
# `hermes`: that silently made local development exercise a different ACP
# contract than production.
hermes_matches_ref() {
  [ -x "$HERMES_AGENT_INSTALL_DIR/venv/bin/hermes" ] \
    && [ -d "$HERMES_AGENT_INSTALL_DIR/.git" ] \
    && [ "$(git -C "$HERMES_AGENT_INSTALL_DIR" rev-parse HEAD 2>/dev/null)" = "$HERMES_AGENT_REF" ] \
    && have hermes \
    && [ "$(command -v hermes)" -ef "$HERMES_AGENT_INSTALL_DIR/venv/bin/hermes" ]
}

if ! $SKIP_HERMES && ! hermes_matches_ref; then
  log "installing hermes (Nous Research) @ ${HERMES_AGENT_REF:0:8}"
  if [ "$os" = linux ] && have apt-get; then
    sudo apt-get update -qq
    sudo apt-get install -y -qq python3 python3-venv python3-dev libffi-dev git build-essential ripgrep ffmpeg
  fi
  hermes_uv=""
  if have uv && uv_supports_hermes "$(command -v uv)"; then
    hermes_uv="$(command -v uv)"
  elif uv_supports_hermes "$HERMES_UV_INSTALL_DIR/uv"; then
    hermes_uv="$HERMES_UV_INSTALL_DIR/uv"
  else
    log "installing current uv for Hermes (uv 0.12+ required)"
    mkdir -p "$HERMES_UV_INSTALL_DIR"
    curl -LsSf --retry 5 --retry-delay 5 --retry-all-errors https://astral.sh/uv/install.sh \
      | env UV_INSTALL_DIR="$HERMES_UV_INSTALL_DIR" UV_NO_MODIFY_PATH=1 sh
    hermes_uv="$HERMES_UV_INSTALL_DIR/uv"
    if ! uv_supports_hermes "$hermes_uv"; then
      echo "Hermes requires uv 0.12 or newer; installed binary is incompatible" >&2
      exit 1
    fi
  fi
  if [ -e "$HERMES_AGENT_INSTALL_DIR" ] && [ ! -d "$HERMES_AGENT_INSTALL_DIR/.git" ]; then
    echo "hermes install path exists but is not a git checkout: $HERMES_AGENT_INSTALL_DIR" >&2
    exit 1
  fi
  if [ -d "$HERMES_AGENT_INSTALL_DIR/.git" ] \
    && ! git -C "$HERMES_AGENT_INSTALL_DIR" diff --quiet --ignore-submodules --; then
    echo "hermes checkout has local changes; refusing to overwrite: $HERMES_AGENT_INSTALL_DIR" >&2
    exit 1
  fi
  if [ ! -d "$HERMES_AGENT_INSTALL_DIR/.git" ]; then
    mkdir -p "$HERMES_AGENT_INSTALL_DIR"
    git -C "$HERMES_AGENT_INSTALL_DIR" init
    git -C "$HERMES_AGENT_INSTALL_DIR" remote add origin https://github.com/NousResearch/hermes-agent.git
  fi
  git -C "$HERMES_AGENT_INSTALL_DIR" fetch --depth 1 origin "$HERMES_AGENT_REF"
  git -C "$HERMES_AGENT_INSTALL_DIR" checkout --detach FETCH_HEAD
  if [ "$(git -C "$HERMES_AGENT_INSTALL_DIR" rev-parse HEAD)" != "$HERMES_AGENT_REF" ]; then
    echo "hermes checkout did not resolve expected ref $HERMES_AGENT_REF" >&2
    exit 1
  fi

  UV_PROJECT_ENVIRONMENT="$HERMES_AGENT_INSTALL_DIR/venv" \
    "$hermes_uv" sync --project "$HERMES_AGENT_INSTALL_DIR" --python 3.11 \
      --extra acp --extra mcp --no-dev --locked --compile-bytecode

  hermes_bin_dir="$($hermes_uv tool dir --bin)"
  mkdir -p "$hermes_bin_dir"
  ln -sf "$HERMES_AGENT_INSTALL_DIR/venv/bin/hermes" "$hermes_bin_dir/hermes"
  ln -sf "$HERMES_AGENT_INSTALL_DIR/venv/bin/hermes-acp" "$hermes_bin_dir/hermes-acp"
  ln -sf "$HERMES_AGENT_INSTALL_DIR/venv/bin/hermes-agent" "$hermes_bin_dir/hermes-agent"
  hash -r
  if ! hermes_matches_ref; then
    echo "hermes install completed but expected ref ${HERMES_AGENT_REF:0:8} is not active on PATH" >&2
    exit 1
  fi
  "$HERMES_AGENT_INSTALL_DIR/venv/bin/python" -c \
    "from mcp.types import CallToolResult; result = CallToolResult(content=[]); assert hasattr(result, 'isError')"
  "$HERMES_AGENT_INSTALL_DIR/venv/bin/python" -c \
    "from acp_adapter.server import HermesACPAgent; import inspect; source = inspect.getsource(HermesACPAgent.prompt); assert 'usage=usage' in source, 'Hermes ACP prompt response must expose exact turn usage'"
elif ! $SKIP_HERMES; then
  log "hermes already matches ${HERMES_AGENT_REF:0:8}"
fi

log "done. installed:"
$SKIP_GRAPHJIN || { printf '  graphjin: '; have graphjin && graphjin version | head -1 || echo 'NOT FOUND'; }
$SKIP_CLAUDE   || { printf '  claude:   '; have claude   && claude --version 2>/dev/null || echo '(installed; --version may differ)'; }
$SKIP_HERMES   || { printf '  hermes:   '; have hermes   && hermes --version 2>/dev/null || echo '(installed; --version may differ)'; }
