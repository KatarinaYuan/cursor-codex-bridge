#!/usr/bin/env python3
"""Hermetic installer tests: temporary homes, fake executables and fake /proc."""

import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest import mock


SPEC = importlib.util.spec_from_file_location("remote_installer", Path(__file__).with_name("remote.py"))
remote = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(remote)


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="cursor bridge tests ' ")
        self.home = Path(self.temporary.name)
        self.proc = self.home / "fake-proc"
        self.proc.mkdir()
        self.bin = self.home / "runtime bin"
        self.bin.mkdir()
        self.executable("node", "if '--version' in sys.argv: print('v22.23.1')")
        self.executable("agent", "if '--version' in sys.argv: print('2025.01.01-test')\nelif 'status' in sys.argv: print('Logged in as account@example.test')\nelif 'acp' in sys.argv: print('Usage: agent acp [options]')")
        self.executable("codex", "print('codex-cli 0.160.0')")
        self.archive = self.home / "runtime.tgz"
        with tarfile.open(self.archive, "w:gz") as bundle:
            for name in ["cli.mjs", "bridge.mjs", "package.json", "node_modules/ws/package.json",
                         "node_modules/ws/wrapper.mjs", "node_modules/wrap-ansi/package.json",
                         "node_modules/wrap-ansi/index.js"]:
                value = b"{}" if name.endswith("json") else b"export {};\n"
                entry = tarfile.TarInfo("./" + name)
                entry.size = len(value)
                bundle.addfile(entry, io.BytesIO(value))
        self.request = {"id": "test-dev", "version": "0.1.0", "archivePath": str(self.archive),
                        "nodePath": str(self.bin / "node"), "agentPath": str(self.bin / "agent"),
                        "codexPath": str(self.bin / "codex")}

    def tearDown(self):
        self.temporary.cleanup()

    def executable(self, name, body):
        path = self.bin / name
        path.write_text("#!" + sys.executable + "\nimport sys\n" + body + "\n")
        path.chmod(0o700)

    def subject(self, **overrides):
        return remote.Remote({**self.request, **overrides}, home=self.home, proc=self.proc, system="Linux")

    def assert_error(self, code, function):
        with self.assertRaises(remote.InstallError) as caught:
            function()
        self.assertEqual(caught.exception.code, code)

    def fake_process(self, subject, pid=12345, kind="server", state=None, script=None, node=None):
        folder = self.proc / str(pid)
        folder.mkdir()
        args = [node or str(self.bin / "node"), script or str(subject.current / "cli.mjs"), "app-server"]
        args += ["proxy"] if kind == "proxy" else ["--listen", "unix://"]
        (folder / "cmdline").write_bytes(b"\0".join(value.encode() for value in args) + b"\0")
        (folder / "environ").write_bytes(b"CODEX_HOME=" + str(state or subject.profile_home).encode() + b"\0")
        (folder / "stat").write_text(str(pid) + " (node worker) S " + "0 " * 18 + "99887 0\n")
        return folder

    def test_probe_detects_prerequisites_without_creating_installation(self):
        subject = self.subject()
        result = subject.probe()
        self.assertTrue(result["ready"])
        self.assertTrue(result["runtime"]["agent"]["loggedIn"])
        self.assertTrue(result["runtime"]["agent"]["acp"])
        self.assertNotIn("account@example.test", json.dumps(result))
        self.assertFalse(subject.root.exists())
        self.assertFalse(subject.state.exists())

    def test_rejects_old_node(self):
        self.executable("node", "print('v20.10.0')")
        result = self.subject().probe()
        self.assertIn("NODE_REQUIRED", [error["code"] for error in result["errors"]])

    def test_rejects_logged_out_agent(self):
        self.executable("agent", "if 'status' in sys.argv: print('Not logged in')\nelif 'acp' in sys.argv: print('Usage: agent acp')\nelse: print('2025.01.01-test')")
        result = self.subject().probe()
        self.assertFalse(result["runtime"]["agent"]["loggedIn"])
        self.assertIn("AGENT_LOGIN_REQUIRED", [error["code"] for error in result["errors"]])

    def test_rejects_unknown_acp(self):
        self.executable("agent", "if 'status' in sys.argv: print('Logged in')\nelif 'acp' in sys.argv: print('Unknown command acp'); sys.exit(1)\nelse: print('2025.01.01-test')")
        result = self.subject().probe()
        self.assertIn("ACP_REQUIRED", [error["code"] for error in result["errors"]])

    def test_rejects_nonlinux_remote(self):
        subject = self.subject()
        subject.system = "Darwin"
        self.assertIn("LINUX_REQUIRED", [error["code"] for error in subject.probe()["errors"]])

    def test_install_profiles_and_wrapper_are_scoped_and_quoted(self):
        subject = self.subject()
        original = b"export USER_SETTING='keep this'\n"
        (self.home / ".profile").write_bytes(original)
        result = subject.install()
        self.assertEqual(result["version"], "0.1.0")
        self.assertTrue(subject.current.is_symlink())
        self.assertTrue((subject.current / "cli.mjs").is_file())
        self.assertFalse((self.home / ".bash_profile").exists())
        self.assertEqual((self.home / ".profile").read_bytes()[:len(original)], original)
        for active in [False, True]:
            env = dict(os.environ)
            env.pop("CODEX_INSTALL_DIR", None)
            env["CODEX_HOME"] = str(subject.profile_home) if active else "/ordinary/codex"
            command = ". " + remote.shlex.quote(str(self.home / ".profile")) + "; printf '%s' \"${CODEX_INSTALL_DIR-unset}\""
            output = subprocess.check_output(["/bin/sh", "-c", command], env=env, text=True)
            self.assertEqual(output, str(subject.root / "bin") if active else "unset")
        self.assertEqual(subject.manifest_path.stat().st_mode & 0o777, 0o600)
        self.assertEqual((subject.root / "bin/codex").stat().st_mode & 0o777, 0o700)

    def test_uses_existing_bash_login_profile_without_masking_it(self):
        (self.home / ".bash_login").write_text("export MY_EXISTING=1\n")
        (self.home / ".profile").write_text("export OTHER_PROFILE=1\n")
        self.subject().install()
        self.assertFalse((self.home / ".bash_profile").exists())
        self.assertIn("cursor-codex-bridge:test-dev", (self.home / ".bash_login").read_text())
        self.assertEqual((self.home / ".profile").read_text(), "export OTHER_PROFILE=1\n")

    def test_locale_activation_sets_dedicated_home_and_survives_upgrade(self):
        subject = self.subject(activationEnv="LC_CURSOR_CODEX_BRIDGE")
        installed = subject.install()
        self.assertEqual(installed["activationEnv"], "LC_CURSOR_CODEX_BRIDGE")
        env = dict(os.environ)
        env["CODEX_HOME"] = "/ordinary/codex"
        env["LC_CURSOR_CODEX_BRIDGE"] = str(subject.profile_home)
        command = ". " + remote.shlex.quote(str(self.home / ".profile")) + "; printf '%s' \"$CODEX_HOME|$CODEX_INSTALL_DIR\""
        output = subprocess.check_output(["/bin/sh", "-c", command], env=env, text=True)
        self.assertEqual(output, str(subject.profile_home) + "|" + str(subject.root / "bin"))
        self.assertEqual(subject.read_manifest()["activationEnv"], "LC_CURSOR_CODEX_BRIDGE")
        self.assertEqual(self.subject().probe()["activationEnv"], "LC_CURSOR_CODEX_BRIDGE")
        upgraded = self.subject(version="0.2.0")
        self.assertEqual(upgraded.install()["activationEnv"], "LC_CURSOR_CODEX_BRIDGE")
        self.assertIn("${LC_CURSOR_CODEX_BRIDGE-}", (self.home / ".profile").read_text())
        self.assertIn("CURSOR_BRIDGE_MAINTENANCE_FILE=", (subject.current / "launch.sh").read_text())

    def test_activation_mode_cannot_be_changed_silently(self):
        self.subject(activationEnv="LC_CURSOR_CODEX_BRIDGE").install()
        self.assert_error("CONFIG_MISMATCH", lambda: self.subject(activationEnv="CODEX_HOME").read_manifest())
        self.assert_error("INVALID_ACTIVATION_ENV", lambda: self.subject(activationEnv="OTHER_VARIABLE"))

    def test_upgrade_keeps_previous_release_and_user_profile_changes(self):
        subject = self.subject()
        subject.install()
        original_release = subject.current.resolve()
        with (self.home / ".profile").open("a") as stream:
            stream.write("export ADDED_LATER=1\n")
        upgraded = self.subject(version="0.2.0")
        upgraded.install()
        self.assertNotEqual(upgraded.current.resolve(), original_release)
        self.assertTrue(original_release.is_dir())
        metadata = upgraded.read_manifest()
        self.assertEqual(Path(metadata["previousRelease"]).resolve(), original_release)
        self.assertEqual(metadata["version"], "0.2.0")
        self.assertEqual((self.home / ".profile").read_text().count("# >>> cursor-codex-bridge:test-dev >>>"), 1)
        self.assertIn("ADDED_LATER=1", (self.home / ".profile").read_text())

    def test_rejects_profile_home_change(self):
        self.subject().install()
        changed = self.subject(profileHome=str(self.home / "different-state"))
        self.assert_error("CONFIG_MISMATCH", changed.read_manifest)

    def test_uninstall_preserves_state_and_other_profile_text(self):
        subject = self.subject()
        original = b"export KEEP_SETTING=1\n"
        (self.home / ".profile").write_bytes(original)
        subject.install()
        (subject.profile_home / "do-not-delete.json").write_text('{"private":"history"}')
        with (self.home / ".profile").open("ab") as stream:
            stream.write(b"export NEW_SETTING=2\n")
        result = subject.uninstall()
        self.assertTrue(result["statePreserved"])
        self.assertFalse(subject.root.exists())
        self.assertTrue((subject.profile_home / "do-not-delete.json").exists())
        self.assertEqual((self.home / ".profile").read_bytes(), original + b"export NEW_SETTING=2\n")
        self.assertEqual((self.home / ".zprofile").read_bytes(), b"")

    def test_uninstall_restores_original_profile_without_final_newline(self):
        subject = self.subject()
        original = b"export KEEP_EXACT_BYTES='no final newline'"
        (self.home / ".profile").write_bytes(original)
        subject.install()
        metadata = subject.read_manifest()["profiles"][0]
        self.assertTrue(metadata["addedSeparator"])
        self.subject(version="0.2.0").install()
        subject.uninstall()
        self.assertEqual((self.home / ".profile").read_bytes(), original)

    def test_separator_proof_preserves_unrelated_manual_newline_edits(self):
        subject = self.subject()
        (self.home / ".profile").write_bytes(b"export KEEP_ORIGINAL=1")
        subject.install()
        profile = self.home / ".profile"
        profile.write_bytes(b"# User added heading\n" + profile.read_bytes())
        subject.uninstall()
        self.assertEqual(profile.read_bytes(), b"# User added heading\nexport KEEP_ORIGINAL=1\n")

    def test_health_detects_broken_current_without_blocking_repair(self):
        subject = self.subject()
        subject.install()
        self.assertTrue(subject.probe()["health"]["ok"])
        subject.current.unlink()
        subject.current.symlink_to("releases/missing")
        probe = subject.probe()
        self.assertTrue(probe["installed"])
        self.assertTrue(probe["ready"])
        self.assertFalse(probe["health"]["ok"])
        self.assertIn("CURRENT_INVALID", [error["code"] for error in probe["health"]["errors"]])
        self.subject(version="0.2.0").install()
        self.assertTrue(subject.probe()["health"]["ok"])

    def test_health_detects_modified_wrapper_and_missing_modules(self):
        subject = self.subject()
        subject.install()
        (subject.root / "bin/codex").write_text("#!/bin/sh\nexit 0\n")
        (subject.current / "node_modules/ws/wrapper.mjs").unlink()
        errors = subject.probe()["health"]["errors"]
        self.assertIn("RUNTIME_FILE_MODIFIED", [error["code"] for error in errors])
        self.assertIn("RUNTIME_FILE_INVALID", [error["code"] for error in errors])

    def test_refuses_modified_managed_profile_block(self):
        subject = self.subject()
        subject.install()
        profile = self.home / ".profile"
        profile.write_text(profile.read_text().replace("active only", "changed manually"))
        self.assert_error("PROFILE_MODIFIED", subject.uninstall)
        self.assertTrue(subject.root.exists())
        self.assert_error("PROFILE_MODIFIED", self.subject(version="0.2.0").install)

    def test_archive_traversal_is_rejected_and_current_unchanged(self):
        subject = self.subject()
        subject.install()
        previous = subject.current.resolve()
        bad = self.home / "bad.tgz"
        with tarfile.open(bad, "w:gz") as bundle:
            entry = tarfile.TarInfo("../escape")
            entry.size = 4
            bundle.addfile(entry, io.BytesIO(b"evil"))
        self.assert_error("INVALID_ARCHIVE", self.subject(version="0.2.0", archivePath=str(bad)).install)
        self.assertEqual(subject.current.resolve(), previous)
        self.assertFalse((subject.root / "escape").exists())
        self.assertEqual(subject.read_manifest()["version"], "0.1.0")

    def test_archive_links_are_rejected(self):
        bad = self.home / "bad-link.tgz"
        with tarfile.open(bad, "w:gz") as bundle:
            entry = tarfile.TarInfo("cli.mjs")
            entry.type = tarfile.SYMTYPE
            entry.linkname = "/etc/passwd"
            bundle.addfile(entry)
        self.assert_error("INVALID_ARCHIVE", self.subject(archivePath=str(bad)).install)

    def test_runtime_validation_failure_keeps_previous_version(self):
        subject = self.subject()
        subject.install()
        previous = subject.current.resolve()
        original_profile = (self.home / ".profile").read_bytes()
        self.executable("node", "if '--version' in sys.argv: print('v22.23.1')\nelse: sys.exit(7)")
        self.assert_error("RUNTIME_CHECK_FAILED", self.subject(version="0.2.0").install)
        self.assertEqual(subject.current.resolve(), previous)
        self.assertEqual((self.home / ".profile").read_bytes(), original_profile)
        self.assertFalse(subject.maintenance.exists())

    def test_profile_write_failure_rolls_back_without_switching(self):
        subject = self.subject()
        subject.install()
        previous = subject.current.resolve()
        profile = (self.home / ".profile").read_bytes()
        real_write = remote.atomic_write
        failed = []
        def fail_once(path, value, mode=0o600):
            if path.name == ".zprofile" and not failed:
                failed.append(True)
                raise OSError("simulated full disk")
            return real_write(path, value, mode)
        with mock.patch.object(remote, "atomic_write", side_effect=fail_once):
            with self.assertRaises(OSError):
                self.subject(version="0.2.0").install()
        self.assertEqual(subject.current.resolve(), previous)
        self.assertEqual((self.home / ".profile").read_bytes(), profile)
        self.assertEqual(subject.read_manifest()["version"], "0.1.0")
        self.assertFalse(subject.maintenance.exists())

    def test_process_matching_excludes_proxies_agents_and_other_state(self):
        subject = self.subject()
        subject.install()
        self.fake_process(subject)
        self.fake_process(subject, pid=12346, kind="proxy")
        self.fake_process(subject, pid=12347, state=self.home / "other-state")
        self.fake_process(subject, pid=12348, script=str(self.bin / "agent"))
        self.fake_process(subject, pid=12349, node="/different/node")
        self.assertEqual([p["pid"] for p in subject.processes(subject.read_manifest())], [12345])

    def test_upgrade_refuses_busy_bridge_without_signals(self):
        subject = self.subject()
        subject.install()
        self.fake_process(subject)
        records = subject.profile_home / "cursor-bridge"
        records.mkdir()
        (records / "test.json").write_text('{"thread":{"turns":[{"status":"inProgress"}]}}')
        with mock.patch.object(remote.os, "kill") as kill:
            self.assert_error("BRIDGE_BUSY", self.subject(version="0.2.0").install)
            kill.assert_not_called()
        self.assertEqual(subject.read_manifest()["version"], "0.1.0")

    def test_stops_only_exact_owned_idle_server(self):
        subject = self.subject()
        subject.install()
        folder = self.fake_process(subject)
        proxy = self.fake_process(subject, pid=12346, kind="proxy")
        calls = []
        def terminate(pid, sig):
            calls.append((pid, sig))
            shutil.rmtree(folder)
        with mock.patch.object(remote.os, "kill", side_effect=terminate):
            with mock.patch.object(remote.Remote, "quiesce") as quiesce:
                self.subject(version="0.2.0").install()
                quiesce.assert_called_once()
        self.assertEqual(calls, [(12345, remote.signal.SIGTERM)])
        self.assertTrue(proxy.exists())

    def test_quiesce_uses_owned_runtime_and_requires_idle_rpc_result(self):
        subject = self.subject()
        subject.install()
        manifest = subject.read_manifest()
        self.assertEqual(manifest["maintenanceProtocol"], 1)
        subject.maintenance.write_text("maintenance\n")
        with mock.patch.object(remote, "run", return_value=(0, '{"idle":true,"reason":"IDLE"}')) as run:
            subject.quiesce(manifest)
        command = run.call_args[0][0]
        self.assertEqual(command[0], manifest["runtime"]["node"]["path"])
        self.assertEqual(command[-1], str(Path(manifest["release"]) / "node_modules/ws/wrapper.mjs"))
        self.assertIn("cursorBridge/maintenance", command[3])
        self.assertEqual(run.call_args[1]["timeout"], 5)

    def test_quiesce_busy_or_timeout_never_sends_signal(self):
        subject = self.subject()
        subject.install()
        self.fake_process(subject)
        subject.maintenance.write_text("maintenance\n")
        for response, expected in [((0, '{"idle":false,"reason":"BUSY"}'), "BRIDGE_BUSY"),
                                   ((-1, ""), "MAINTENANCE_NOT_CONFIRMED")]:
            with mock.patch.object(remote, "run", return_value=response):
                with mock.patch.object(remote.os, "kill") as kill:
                    self.assert_error(expected, lambda: subject.stop_owned(subject.read_manifest()))
                    kill.assert_not_called()

    def test_older_running_bridge_requires_manual_connection_close(self):
        subject = self.subject()
        subject.install()
        self.fake_process(subject)
        subject.maintenance.write_text("maintenance\n")
        manifest = subject.read_manifest()
        manifest.pop("maintenanceProtocol")
        with mock.patch.object(remote.os, "kill") as kill:
            self.assert_error("MAINTENANCE_UNSUPPORTED", lambda: subject.stop_owned(manifest))
            kill.assert_not_called()

    def test_uninstall_without_saved_node_is_safe_only_without_running_server(self):
        subject = self.subject()
        subject.install()
        process = self.fake_process(subject)
        (self.bin / "node").unlink()
        with mock.patch.object(remote.os, "kill") as kill:
            self.assert_error("MAINTENANCE_RUNTIME_MISSING", subject.uninstall)
            kill.assert_not_called()
        self.assertTrue(subject.root.exists())
        shutil.rmtree(process)
        self.assertFalse(subject.uninstall()["installed"])

    def test_refuses_unowned_existing_directory(self):
        subject = self.subject()
        subject.root.mkdir(parents=True)
        (subject.root / "not-ours").write_text("keep")
        self.assert_error("UNOWNED_PATH", subject.install)
        self.assertEqual((subject.root / "not-ours").read_text(), "keep")

    def test_rejects_profile_symlink_outside_home(self):
        with tempfile.TemporaryDirectory() as external:
            target = Path(external) / "profile"
            target.write_text("outside\n")
            (self.home / ".profile").symlink_to(target)
            self.assert_error("UNSAFE_PROFILE", self.subject().install)
            self.assertEqual(target.read_text(), "outside\n")

    def test_invalid_ids_and_state_inside_runtime_are_rejected(self):
        self.assert_error("INVALID_ID", lambda: self.subject(id="../../evil"))
        subject = self.subject()
        self.assert_error("INVALID_PATH", lambda: self.subject(profileHome=str(subject.root / "state")))


if __name__ == "__main__":
    unittest.main()
