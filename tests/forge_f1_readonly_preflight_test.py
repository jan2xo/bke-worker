#!/usr/bin/env python3
"""Executable adversarial F1-01 preflight tests using a REAL disposable Git repo.

The fixture copy changes ONLY platform identity and the network test endpoint:
macOS id/uname are simulated on Linux CI, and a local bare Git remote replaces
GitHub for deterministic offline tests. All local Git inspection runs unmodified
through the real /usr/bin/git, including hostile config/environment scenarios.
No real Chrome process, browser profile, host, login or provider is used.
"""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

SOURCE = Path(__file__).resolve().parents[1] / "scripts/forge-f1-desktop-readiness.sh"
GIT = "/usr/bin/git"
assert Path(GIT).is_file(), "real Git executable required"


def stub(directory, name, body):
    file = directory / name
    file.write_text("#!/bin/sh\n" + body, encoding="utf-8")
    file.chmod(0o700)
    return file


with tempfile.TemporaryDirectory(prefix="bke-f1-real-git-") as temporary:
    base = Path(temporary)
    root, bare, home = base / "repo", base / "remote.git", base / "home"
    root.mkdir()
    home.mkdir()
    bin_dir = base / "bin"
    bin_dir.mkdir()
    marker = base / "EXECUTED_UNTRUSTED_CONFIG"
    calls = base / "unexpected_calls"
    stub(bin_dir, "git", 'echo git-injected >> "$BKE_UNEXPECTED_CALLS"\nexit 99\n')
    stub(bin_dir, "uname", 'printf "Darwin\\n"\n')
    stub(bin_dir, "id", 'printf "501\\n"\n')
    stub(bin_dir, "node", 'printf "%s\\n" "$BKE_NODE_VERSION"\n')
    for cmd in ("npm", "python3"):
        stub(bin_dir, cmd, 'echo tool-invoked >> "$BKE_UNEXPECTED_CALLS"\nexit 99\n')

    fixture_env = {
        **os.environ,
        "HOME": str(home), "PATH": f"{bin_dir}:/usr/bin:/bin",
        "BKE_NODE_VERSION": "v22.9.0", "BKE_UNEXPECTED_CALLS": str(calls),
    }
    def git(*args):
        result = subprocess.run([GIT, *args], env={
            **os.environ, "HOME": str(home), "GIT_CONFIG_GLOBAL": "/dev/null",
            "GIT_CONFIG_NOSYSTEM": "1",
        }, text=True, capture_output=True, timeout=10)
        assert result.returncode == 0, (args, result.stdout, result.stderr)
        return result.stdout.strip()

    git("init", "-q", str(root))
    git("-C", str(root), "symbolic-ref", "HEAD", "refs/heads/main")
    git("init", "--bare", "-q", str(bare))
    script = root / "scripts/forge-f1-desktop-readiness.sh"
    script.parent.mkdir()
    script_text = SOURCE.read_text(encoding="utf-8")
    assert 'preflight_git -C / ls-remote https://github.com/jan2xo/bke-worker.git refs/heads/main' in script_text
    # Controlled test-only substitutions, never pushed to actual PR.
    script_text = script_text.replace("$(/usr/bin/id -u)", "$(id -u)")
    script_text = script_text.replace("$(/usr/bin/uname -s)", "$(uname -s)")
    script_text = script_text.replace(
        "preflight_git -C / ls-remote https://github.com/jan2xo/bke-worker.git refs/heads/main",
        f"preflight_git -C / ls-remote file://{bare} refs/heads/main",
    )
    script.write_text(script_text, encoding="utf-8")
    git("-C", str(root), "remote", "add", "origin", "https://github.com/jan2xo/bke-worker.git")
    git("-C", str(root), "add", "scripts/forge-f1-desktop-readiness.sh")
    git("-C", str(root), "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
        "commit", "-qm", "disposable F1 source fixture")
    git("-C", str(root), "push", "-q", str(bare), "HEAD:refs/heads/main")

    chrome = home / "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    chrome.parent.mkdir(parents=True)
    chrome.write_text("#!/bin/sh\necho Chrome-must-not-run >> \"$BKE_UNEXPECTED_CALLS\"\nexit 99\n")
    chrome.chmod(0o700)
    policy = home / ".config/bke-worker/native-host/owner-policy.json"
    policy.parent.mkdir(parents=True)
    policy.write_text("POLICY_SECRET_MUST_NOT_BE_READ", encoding="utf-8")
    git_config = root / ".git/config"
    git_index = root / ".git/index"
    clean_config = git_config.read_bytes()

    def check(expected, extra=None):
        calls.unlink(missing_ok=True)
        marker.unlink(missing_ok=True)
        before_config, before_index = git_config.read_bytes(), git_index.read_bytes()
        result = subprocess.run(
            ["/bin/bash", str(script), "--preflight-readonly"],
            env={**fixture_env, **(extra or {})},
            text=True, capture_output=True, timeout=15,
        )
        output = result.stdout + result.stderr
        if expected == "READ_ONLY_PASS":
            assert result.returncode == 0, (expected, result.returncode, output)
            assert "BKE_F1_PREFLIGHT=READ_ONLY_PASS" in output, output
            assert git("-C", str(root), "rev-parse", "HEAD") in output
        else:
            assert result.returncode == 2 and f"reason={expected}" in output, (
                expected, result.returncode, output)
        for evidence in ("BKE_F1_SOURCE_SMOKE=NOT_RUN",
                         "BKE_F1_REAL_CHROME=NOT_TESTED",
                         "BKE_F1_NATIVE_HANDSHAKE=NOT_RUN"):
            assert evidence in output, (evidence, output)
        assert str(root) not in output and str(home) not in output, output
        assert "POLICY_SECRET_MUST_NOT_BE_READ" not in output
        assert not marker.exists(), "malicious Git configuration executed"
        assert not calls.exists(), "PATH hijack or forbidden command executed"
        assert git_config.read_bytes() == before_config
        assert git_index.read_bytes() == before_index, "preflight wrote Git index"
        assert not (root / ".git/index.lock").exists()
        return output

    check("READ_ONLY_PASS")
    evil = stub(bin_dir, "evil", f'echo executed > "{marker}"\n')
    poisoned_global = home / "malicious.gitconfig"
    poisoned_global.write_text(
        f'[core]\n\tfsmonitor = {evil}\n'
        f'[credential]\n\thelper = !{evil}\n'
        f'[url "file://{base}/redirect/"]\n\tinsteadOf = file://{bare}\n',
        encoding="utf-8",
    )
    attacker = base / "attacker"
    git("init", "-q", str(attacker))
    poisoned = {
        "GIT_DIR": str(attacker / ".git"),
        "GIT_WORK_TREE": str(attacker),
        "GIT_INDEX_FILE": str(base / "stolen-index"),
        "GIT_COMMON_DIR": str(attacker / ".git"),
        "GIT_CONFIG_GLOBAL": str(poisoned_global),
        "GIT_CONFIG_SYSTEM": str(poisoned_global),
        "GIT_CONFIG_COUNT": "3",
        "GIT_CONFIG_KEY_0": "core.fsmonitor",
        "GIT_CONFIG_VALUE_0": str(evil),
        "GIT_CONFIG_KEY_1": f"url.file://{base}/redirect/.insteadof",
        "GIT_CONFIG_VALUE_1": f"file://{bare}",
        "GIT_CONFIG_KEY_2": "credential.helper",
        "GIT_CONFIG_VALUE_2": f"!{evil}",
        "GIT_EXEC_PATH": str(bin_dir),
        "GIT_SSH_COMMAND": str(evil), "GIT_ASKPASS": str(evil),
        "GIT_CONFIG_PARAMETERS": "'core.fsmonitor=malicious'",
    }
    check("READ_ONLY_PASS", poisoned)
    cases = [
        ("core.fsmonitor", str(evil)),
        ("credential.helper", f"!{evil}"),
        ("url.file:///tmp/redirect.insteadof", "https://github.com/"),
        ("include.path", str(poisoned_global)),
        ("core.worktree", str(attacker)),
        ("filter.inject.clean", str(evil)),
        ("remote.origin.proxy", str(evil)),
        ("alias.status", f"!{evil}"),
    ]
    for key, value in cases:
        git_config.write_bytes(clean_config)
        git("-C", str(root), "config", "--local", key, value)
        check("GIT_CONFIG_UNSAFE")
    git_config.write_bytes(clean_config)
    check("READ_ONLY_PASS", poisoned)

    git("-C", str(root), "remote", "set-url", "origin", "https://example.invalid/forged")
    check("ORIGIN_REPOSITORY_UNTRUSTED")
    git_config.write_bytes(clean_config)
    git("-C", str(root), "symbolic-ref", "HEAD", "refs/heads/other")
    check("CHECKOUT_NOT_MAIN")
    git("-C", str(root), "symbolic-ref", "HEAD", "refs/heads/main")
    pristine_script = script.read_bytes()
    script.write_bytes(pristine_script + b"\n# dirty fixture\n")
    check("CHECKOUT_DIRTY")
    script.write_bytes(pristine_script)
    check("READ_ONLY_PASS")

    chrome.unlink()
    check("GOOGLE_CHROME_APP_PATH_NOT_FOUND")
    chrome.write_text("#!/bin/sh\nexit 99\n")
    chrome.chmod(0o700)
    policy.unlink()
    check("OWNER_POLICY_FILE_MISSING")
    policy.symlink_to(base / "outside-secret")
    check("OWNER_POLICY_PATH_SYMLINK")
    policy.unlink()
    policy.write_text("POLICY_SECRET_MUST_NOT_BE_READ")
    check("NODE_22_OR_NEWER_REQUIRED", {"BKE_NODE_VERSION": "v20.0.0"})

    git_config.unlink()
    git_config.symlink_to(poisoned_global)
    result = subprocess.run(
        ["/bin/bash", str(script), "--preflight-readonly"],
        env=fixture_env, capture_output=True, text=True, timeout=10,
    )
    assert result.returncode == 2 and "reason=GIT_DIRECTORY_UNSAFE" in result.stdout
    git_config.unlink()
    git_config.write_bytes(clean_config)
    calls.unlink(missing_ok=True)
    result = subprocess.run(
        ["/bin/bash", str(script), "--preflight-readonly", "--unexpected"],
        env=fixture_env, capture_output=True, text=True, timeout=10,
    )
    assert result.returncode == 2 and "UNKNOWN_ARGUMENT" in result.stderr
    assert not calls.exists()

print("BKE F1 preflight real-Git adversarial test: PASS (offline fixture)")
