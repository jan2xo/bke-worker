#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_DIR="${BKE_WORKER_CONFIG_DIR:-$HOME/.config/bke-worker}"

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
sudo apt-get install -y   ca-certificates   curl   git   jq   dotnet-sdk-10.0

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

mkdir -p "$CONFIG_DIR"
chmod 700 "$CONFIG_DIR"

if [[ ! -f "$CONFIG_DIR/bke-worker.env" ]]; then
  install -m 600 "$ROOT_DIR/scripts/bke-worker.env.example" "$CONFIG_DIR/bke-worker.env"
  echo "Created worker config template: $CONFIG_DIR/bke-worker.env"
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
dotnet test tests/BKE.Worker.GitHub.Tests/BKE.Worker.GitHub.Tests.csproj -c Release
dotnet test tests/BKE.Worker.ChatGPT.Tests/BKE.Worker.ChatGPT.Tests.csproj -c Release --no-build

cat <<EOF

BOOTSTRAP GREEN

Next for EACH worker:
  1. Copy $CONFIG_DIR/bke-worker.env to a dedicated file such as worker-a.env.
  2. Set a unique BKE_WORKER_ID, ChatGPT target, browser profile, CDP port,
     state file, and ASPNETCORE_URLS port.
  3. Create the matching GitHub PR assignment label:
       bke-worker:<worker_id>
  4. Configure the repository webhook to send push + pull_request events.
  5. Enter the host GUI session and load that worker environment.
  6. Start its normal system Chromium with:
       bash scripts/start-chatgpt-browser.sh
  7. Complete ChatGPT/OAuth/MFA manually if required.
  8. Verify the worker-specific loopback CDP host with:
       bash scripts/verify-live-host.sh
  9. Start that worker with:
       BKE_WORKER_ENV_FILE=<worker-env> bash scripts/run-worker.sh

For systemd multi-instance deployment, use deploy/systemd/bke-worker@.service
with one /etc/bke-worker/<worker_id>.env file per worker.

GUARD: BKE Worker never automates OAuth, MFA, CAPTCHA, or login credentials.
EOF
