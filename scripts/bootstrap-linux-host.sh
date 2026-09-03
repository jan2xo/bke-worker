#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_DIR="${BKE_WORKER_CONFIG_DIR:-$HOME/.config/bke-worker}"
PROFILE_DIR="${BKE_WORKER_CHATGPT_PROFILE:-$HOME/snap/chromium/common/bke-worker-chatgpt-profile}"
STATE_DIR="$(dirname "${BKE_WORKER_STATE_FILE:-$HOME/.local/share/bke-worker/state/worker.json}")"

if [[ ! -r /etc/os-release ]]; then
  echo "ERROR: /etc/os-release is unavailable. This bootstrap targets Ubuntu Linux." >&2
  exit 1
fi

# shellcheck disable=SC1091
source /etc/os-release
if [[ "${ID:-}" != "ubuntu" ]]; then
  echo "ERROR: unsupported distro '${ID:-unknown}'. Ubuntu is the certified live-host target." >&2
  exit 1
fi

if [[ "$(uname -m)" != "aarch64" && "$(uname -m)" != "x86_64" ]]; then
  echo "ERROR: unsupported architecture $(uname -m)." >&2
  exit 1
fi

echo "BKE Worker live-host bootstrap"
echo "  distro: ${PRETTY_NAME:-Ubuntu}"
echo "  arch:   $(uname -m)"

sudo apt-get update
sudo apt-get install -y \
  ca-certificates \
  curl \
  git \
  jq \
  dotnet-sdk-10.0

if ! command -v snap >/dev/null 2>&1; then
  echo "ERROR: snap is required for the certified Ubuntu Chromium path." >&2
  exit 1
fi

if ! command -v chromium >/dev/null 2>&1; then
  sudo snap install chromium
fi

if ! command -v pwsh >/dev/null 2>&1; then
  sudo snap install powershell --classic
fi

mkdir -p "$CONFIG_DIR" "$PROFILE_DIR" "$STATE_DIR"
chmod 700 "$CONFIG_DIR" "$PROFILE_DIR" "$STATE_DIR"

if [[ ! -f "$CONFIG_DIR/bke-worker.env" ]]; then
  install -m 600 "$ROOT_DIR/scripts/bke-worker.env.example" "$CONFIG_DIR/bke-worker.env"
  echo "Created protected config template: $CONFIG_DIR/bke-worker.env"
else
  chmod 600 "$CONFIG_DIR/bke-worker.env"
  echo "Preserved existing config: $CONFIG_DIR/bke-worker.env"
fi

cd "$ROOT_DIR"

dotnet restore tests/BKE.Worker.ChatGPT.Tests/BKE.Worker.ChatGPT.Tests.csproj
dotnet build tests/BKE.Worker.ChatGPT.Tests/BKE.Worker.ChatGPT.Tests.csproj -c Release --no-restore
pwsh -File tests/BKE.Worker.ChatGPT.Tests/bin/Release/net10.0/playwright.ps1 install --with-deps chromium

dotnet build src/BKE.Worker.Server/BKE.Worker.Server.csproj -c Release
dotnet test tests/BKE.Worker.Core.Tests/BKE.Worker.Core.Tests.csproj -c Release
dotnet test tests/BKE.Worker.ChatGPT.Tests/BKE.Worker.ChatGPT.Tests.csproj -c Release --no-build

cat <<EOF

BOOTSTRAP GREEN

Next:
  1. Edit: $CONFIG_DIR/bke-worker.env
  2. Enter the host GUI session.
  3. Start normal system Chromium with:
       bash scripts/start-chatgpt-browser.sh
  4. Complete ChatGPT/OAuth/MFA manually if required.
  5. Verify the loopback CDP host with:
       bash scripts/verify-live-host.sh
  6. Start BKE Worker with:
       bash scripts/run-worker.sh

GUARD: BKE Worker never automates OAuth, MFA, CAPTCHA, or login credentials.
EOF
