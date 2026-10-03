#!/usr/bin/env python3
import os
import subprocess
import tempfile
from pathlib import Path

root = Path(__file__).resolve().parents[1]
relay = (root / "tools/utm-relay/mock_relay.py").read_text(encoding="utf-8")
tls_path = root / "tools/utm-relay/generate-dev-tls.sh"
tls = tls_path.read_text(encoding="utf-8")
readme = (root / "tools/utm-relay/README.md").read_text(encoding="utf-8")
manifest = (root / "android-gecko/app/src/main/AndroidManifest.xml").read_text(encoding="utf-8")
network = (
    root / "android-gecko/app/src/main/res/xml/network_security_config.xml"
).read_text(encoding="utf-8")
gitignore = (root / ".gitignore").read_text(encoding="utf-8")

for token in (
    "websockets.serve(",
    "ssl=ssl_context",
    'CONTROL_REPO = "jan2xo/bke-worker"',
    '"protocol": PROTOCOL',
    '"type": "wake"',
    '"worker_id": args.worker_id',
    '"repo": CONTROL_REPO',
    '"pr_number": args.pr',
    '"expected_head_sha": args.head_sha',
    '"delivery_id": args.delivery_id',
    "hmac.compare_digest(auth, expected)",
    "validate_register(",
):
    assert token in relay, token

for forbidden in (
    '"prompt":',
    '"javascript":',
    '"command":',
    "GITHUB_TOKEN",
    "ghp_",
):
    assert forbidden not in relay, forbidden

for token in (
    "openssl req -x509",
    "subjectAltName=$SAN",
    "chmod 600",
    "Never copy the CA private key",
):
    assert token in tls, token

# Execute the TLS generator instead of relying on source-string checks alone.
# This specifically proves the documented default output path and the optional
# environment override both expand as shell parameters rather than becoming
# literal directory names.
with tempfile.TemporaryDirectory() as temp_dir:
    workdir = Path(temp_dir)
    subprocess.run(
        ["bash", str(tls_path), "127.0.0.1"],
        cwd=workdir,
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    default_tls = workdir / ".bke-worker-utm-relay/tls"
    for name in (
        "bke-worker-dev-ca.crt",
        "bke-worker-dev-ca.key",
        "server.crt",
        "server.key",
    ):
        assert (default_tls / name).is_file(), name
    assert not (workdir / "${BKE_UTM_RELAY_TLS_DIR:-.bke-worker-utm-relay/tls}").exists()

with tempfile.TemporaryDirectory() as temp_dir:
    workdir = Path(temp_dir)
    override_tls = workdir / "custom-tls"
    env = os.environ.copy()
    env["BKE_UTM_RELAY_TLS_DIR"] = str(override_tls)
    subprocess.run(
        ["bash", str(tls_path), "localhost"],
        cwd=workdir,
        env=env,
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    for name in (
        "bke-worker-dev-ca.crt",
        "bke-worker-dev-ca.key",
        "server.crt",
        "server.key",
    ):
        assert (override_tls / name).is_file(), name

assert 'android:networkSecurityConfig="@xml/network_security_config"' in manifest
assert '<base-config cleartextTrafficPermitted="false">' in network
assert '<certificates src="system" />' in network
assert "<debug-overrides>" in network
assert '<certificates src="user" />' in network
assert ".bke-worker-utm-relay/" in gitignore

for token in (
    "preproduction-only",
    "wss://<UTM_IP>:8787",
    "Runtime relay token",
    "fail closed",
):
    assert token in readme, token

print("BKE Worker UTM WSS relay smoke contract: PASS")
