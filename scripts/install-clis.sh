#!/usr/bin/env bash
# Install the two external CLIs used for local agent development:
#   - graphjin  (always required; the metric agent runs `graphjin cli`)
#   - hermes    (the OpenNeko agent runtime)
#
# Idempotent. Pass --skip-hermes for GraphJin-only development. macOS uses
# Homebrew where possible; Debian/Ubuntu uses apt +
# direct installers. Other distros: read the body and adapt.
#
# Usage:
#   ./scripts/install-clis.sh                # install both
#   ./scripts/install-clis.sh --skip-hermes  # graphjin only
set -euo pipefail

GRAPHJIN_VERSION="${GRAPHJIN_VERSION:-3.20.47}"
# Pin Hermes to the same ref baked into the Dockerfile so local-dev installs
# match what ships in the container image. v2026.5.16 / v0.14.0.
HERMES_AGENT_REF="${HERMES_AGENT_REF:-a91a57fa5a13d516c38b07a141a9ce8a3daabeb0}"
HERMES_AGENT_VERSION="0.14.0"

SKIP_GRAPHJIN=false
SKIP_HERMES=false
for arg in "$@"; do
  case "$arg" in
    --skip-graphjin) SKIP_GRAPHJIN=true ;;
    --skip-hermes)   SKIP_HERMES=true ;;
    -h|--help)
      sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

log() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

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

# ─── hermes (Nous Research) ────────────────────────────────────────────
# Hermes v0.14.0 supports a normal uv tool install. Check the active executable
# so running this installer also replaces an existing v0.20 installation.
hermes_matches_version() {
  have hermes && hermes --version 2>/dev/null | grep -Eq '(^|[^0-9])0\.14\.0([^0-9]|$)'
}

if ! $SKIP_HERMES && ! hermes_matches_version; then
  log "installing hermes (Nous Research) @ ${HERMES_AGENT_REF:0:8}"
  if [ "$os" = linux ] && have apt-get; then
    sudo apt-get update -qq
    sudo apt-get install -y -qq python3 python3-venv python3-dev libffi-dev git build-essential ripgrep ffmpeg
  fi
  if ! have uv; then
    log "installing uv"
    if [ "$os" = macos ] && have brew; then
      brew install uv
    else
      curl -LsSf https://astral.sh/uv/install.sh | sudo env UV_INSTALL_DIR=/usr/local/bin sh -s -- --no-modify-path
    fi
  fi

  uv tool install --force --python 3.11 \
    --with mcp --with websockets \
    "hermes-agent[acp] @ git+https://github.com/NousResearch/hermes-agent.git@${HERMES_AGENT_REF}"

  hermes_tool_root="$(uv tool dir)/hermes-agent"
  hermes_python="$hermes_tool_root/bin/python"
  hermes_mcp_tool="$hermes_tool_root/lib/python3.11/site-packages/tools/mcp_tool.py"
  if [ ! -f "$hermes_mcp_tool" ]; then
    echo "hermes v${HERMES_AGENT_VERSION} MCP adapter was not installed at $hermes_mcp_tool" >&2
    exit 1
  fi
  if grep -q 'result\.isError' "$hermes_mcp_tool"; then
    sed -i.bak 's/result\.isError/result.is_error/g' "$hermes_mcp_tool"
    rm -f "$hermes_mcp_tool.bak"
  fi
  if grep -q 'result\.isError' "$hermes_mcp_tool"; then
    echo "hermes v${HERMES_AGENT_VERSION} MCP adapter compatibility patch failed" >&2
    exit 1
  fi
  hash -r
  if ! hermes_matches_version; then
    echo "hermes install completed but v${HERMES_AGENT_VERSION} is not active on PATH" >&2
    exit 1
  fi
  "$hermes_python" -c \
    "import hermes_cli; assert hermes_cli.__version__ == '${HERMES_AGENT_VERSION}'"
  "$hermes_python" -c \
    "from mcp.types import CallToolResult; result = CallToolResult(content=[]); assert hasattr(result, 'is_error')"
  "$hermes_python" -c \
    "from acp_adapter.server import HermesACPAgent; import inspect; source = inspect.getsource(HermesACPAgent.prompt); assert 'usage=usage' in source, 'Hermes ACP prompt response must expose exact turn usage'"
elif ! $SKIP_HERMES; then
  log "hermes already matches v${HERMES_AGENT_VERSION}"
fi

log "done. installed:"
$SKIP_GRAPHJIN || { printf '  graphjin: '; have graphjin && graphjin version | head -1 || echo 'NOT FOUND'; }
$SKIP_HERMES   || { printf '  hermes:   '; have hermes   && hermes --version 2>/dev/null || echo '(installed; --version may differ)'; }
