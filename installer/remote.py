#!/usr/bin/env python3
"""User-scoped remote installer. JSON stdin/stdout; never starts an Agent chat."""

import contextlib
import datetime
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import shlex
import shutil
import signal
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import uuid


OWNER = "cursor-codex-bridge"
SCHEMA = 1
MAX_ARCHIVE = 128 * 1024 * 1024
MAX_CONTENTS = 512 * 1024 * 1024
IDENTIFIER = re.compile(r"^[a-z0-9][a-z0-9_-]{0,47}$")
VERSION = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+-]{0,79}$")


class InstallError(Exception):
    def __init__(self, code, message, details=None):
        super().__init__(message)
        self.code, self.details = code, details


def digest(data):
    return hashlib.sha256(data).hexdigest()


def json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode()


def safe_path(value):
    if not isinstance(value, str) or not value or any(ord(c) < 32 for c in value):
        raise InstallError("INVALID_PATH", "Paths must be non-empty strings without control characters")
    p = Path(value)
    if not p.is_absolute():
        raise InstallError("INVALID_PATH", "Remote paths must be absolute")
    return p


def inside(path, parent):
    try:
        path.resolve().relative_to(parent.resolve())
        return True
    except ValueError:
        return False


def atomic_write(path, data, mode=0o600):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(prefix="." + path.name + ".", dir=str(path.parent))
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def run(arguments, env=None, timeout=12):
    try:
        result = subprocess.run(arguments, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, env=env, timeout=timeout, check=False)
        return result.returncode, result.stdout[:256 * 1024].decode("utf-8", "replace")
    except (OSError, subprocess.TimeoutExpired):
        return -1, ""


class Remote:
    def __init__(self, request, home=None, proc=None, system=None):
        self.request = request
        self.activation_env = request.get("activationEnv", "CODEX_HOME")
        if self.activation_env not in {"CODEX_HOME", "LC_CURSOR_CODEX_BRIDGE"}:
            raise InstallError("INVALID_ACTIVATION_ENV", "activationEnv must be CODEX_HOME or LC_CURSOR_CODEX_BRIDGE")
        self.home = Path(home) if home is not None else Path.home()
        self.proc = Path(proc) if proc is not None else Path("/proc")
        self.system = system or platform.system()
        self.id = request.get("id", "default")
        if not isinstance(self.id, str) or not IDENTIFIER.fullmatch(self.id):
            raise InstallError("INVALID_ID", "id must contain 1–48 lowercase letters, digits, underscores or hyphens")
        self.root = self.home / ".local/share" / OWNER / self.id
        self.state = self.home / ".local/state" / OWNER / self.id
        self.profile_home = safe_path(request["profileHome"]) if request.get("profileHome") else self.state
        if not inside(self.root, self.home) or not inside(self.state, self.home):
            raise InstallError("INVALID_PATH", "Installation directories must resolve inside the remote user's home")
        if not inside(self.profile_home, self.home) or inside(self.profile_home, self.root):
            raise InstallError("INVALID_PATH", "profileHome must be inside the remote user's home")
        self.manifest_path = self.root / "installation.json"
        self.marker_path = self.root / ".owner.json"
        self.current = self.root / "current"
        self.maintenance = self.root / ".maintenance"

    def paths(self):
        return {"home": str(self.home), "root": str(self.root), "state": str(self.profile_home),
                "profileHome": str(self.profile_home), "bin": str(self.root / "bin"),
                "wrapper": str(self.root / "bin/codex"), "current": str(self.current),
                "manifest": str(self.manifest_path)}

    def read_manifest(self):
        if not self.manifest_path.exists():
            return None
        try:
            result = json.loads(self.manifest_path.read_text())
        except (OSError, ValueError):
            raise InstallError("INVALID_INSTALLATION", "Installation metadata cannot be read")
        if result.get("owner") != OWNER or result.get("id") != self.id or result.get("schemaVersion") != SCHEMA:
            raise InstallError("INVALID_INSTALLATION", "Installation metadata does not belong to this installer")
        if result.get("paths", {}).get("root") != str(self.root):
            raise InstallError("INVALID_INSTALLATION", "Installation path differs from its ownership metadata")
        activation_env = result.get("activationEnv", "CODEX_HOME")
        if activation_env not in {"CODEX_HOME", "LC_CURSOR_CODEX_BRIDGE"}:
            raise InstallError("INVALID_INSTALLATION", "Saved activation environment is invalid")
        if "activationEnv" in self.request and self.request["activationEnv"] != activation_env:
            raise InstallError("CONFIG_MISMATCH", "activationEnv differs from the existing installation")
        self.activation_env = activation_env
        old_home = result.get("paths", {}).get("profileHome")
        if old_home:
            if self.request.get("profileHome") and str(safe_path(self.request["profileHome"])) != old_home:
                raise InstallError("CONFIG_MISMATCH", "profileHome differs from the existing installation")
            self.profile_home = safe_path(old_home)
            if not inside(self.profile_home, self.home) or inside(self.profile_home, self.root):
                raise InstallError("INVALID_INSTALLATION", "Saved state path is outside the remote home")
        return result

    def assert_owner(self):
        if not self.root.exists():
            return
        if self.root.is_symlink():
            raise InstallError("UNOWNED_PATH", "Installation root must not be a symbolic link")
        try:
            marker = json.loads(self.marker_path.read_text())
        except (OSError, ValueError):
            if not any(self.root.iterdir()):
                return
            raise InstallError("UNOWNED_PATH", "Existing installation directory has no valid ownership marker")
        if marker != {"owner": OWNER, "id": self.id, "schemaVersion": SCHEMA}:
            raise InstallError("UNOWNED_PATH", "Existing directory belongs to a different installation")

    def candidates(self, command, explicit=None, extra=()):
        values = []
        if explicit:
            values.append(str(safe_path(explicit)))
        else:
            found = shutil.which(command)
            if found:
                values.append(found)
            values += [str(self.home / ".local/bin" / command), str(self.home / ".cursor/bin" / command),
                       str(self.home / ".npm-global/bin" / command), "/usr/local/bin/" + command,
                       "/usr/bin/" + command]
            for base in [self.home / ".nvm/versions/node", Path("/usr/local/nvm/versions/node")]:
                if base.is_dir():
                    versions = sorted(base.iterdir(), key=lambda p: tuple(int(x) for x in re.findall(r"\d+", p.name)), reverse=True)
                    values += [str(p / "bin" / command) for p in versions]
            private_runtime = self.home / ".local/share" / OWNER / "runtimes"
            values += [str(p / "bin" / command) for p in sorted(private_runtime.glob("node-*"), reverse=True)]
            if command == "codex":
                values += [str(p / "bin/codex") for p in sorted(private_runtime.glob("codex-*"), reverse=True)]
            values += list(extra)
        seen = set()
        for item in values:
            p = Path(item)
            if str(p) in seen or not p.is_file() or not os.access(p, os.X_OK) or inside(p, self.root):
                continue
            seen.add(str(p))
            yield str(p)

    def runtime(self, previous=None):
        previous = previous or {}
        options = self.request
        runtime = {"node": None, "agent": None, "codex": None}
        errors = []
        for executable in self.candidates("node", options.get("nodePath"),
                                          [previous.get("node", {}).get("path", "")]):
            code, output = run([executable, "--version"])
            match = re.search(r"\bv(\d+)\.(\d+)\.(\d+)\b", output)
            if code == 0 and match and int(match[1]) >= 22:
                runtime["node"] = {"path": executable, "version": match[0]}
                break
        if not runtime["node"]:
            errors.append({"code": "NODE_REQUIRED", "message": "Install Node.js 22 or newer on the development machine, or supply --node-path"})
        env = dict(os.environ)
        if runtime["node"]:
            env["PATH"] = str(Path(runtime["node"]["path"]).parent) + os.pathsep + env.get("PATH", "")
        agent_extra = [previous.get("agent", {}).get("path", "")]
        if not options.get("agentPath"):
            cursor_agent = shutil.which("cursor-agent")
            if cursor_agent:
                agent_extra.append(cursor_agent)
            agent_extra += [str(self.home / ".local/bin/cursor-agent"), "/usr/local/bin/cursor-agent"]
        for executable in self.candidates("agent", options.get("agentPath"), agent_extra):
            code, output = run([executable, "--version"], env)
            if code != 0:
                continue
            version = next((s.strip() for s in output.splitlines() if s.strip()), "unknown")[:100]
            status_code, status_output = run([executable, "status"], env)
            logged_in = status_code == 0 and bool(re.search(r"logged\s+in|authenticated", status_output, re.I)) and not bool(re.search(r"not\s+(?:logged\s+in|authenticated)|unauthenticated|logged\s+out", status_output, re.I))
            help_code, help_output = run([executable, "acp", "--help"], env)
            acp = help_code == 0 and bool(re.search(r"\bacp\b|agent\s+client\s+protocol", help_output, re.I)) and not bool(re.search(r"unknown\s+(?:command|option)|unrecognized", help_output, re.I))
            runtime["agent"] = {"path": executable, "version": version, "loggedIn": logged_in, "acp": acp}
            break
        if not runtime["agent"]:
            errors.append({"code": "AGENT_REQUIRED", "message": "Cursor Agent was not found; install it remotely or supply --agent-path"})
        else:
            if not runtime["agent"]["loggedIn"]:
                errors.append({"code": "AGENT_LOGIN_REQUIRED", "message": "Cursor login could not be confirmed; run agent status and agent login remotely"})
            if not runtime["agent"]["acp"]:
                errors.append({"code": "ACP_REQUIRED", "message": "Cursor Agent ACP support could not be confirmed; update Cursor Agent"})
        for executable in self.candidates("codex", options.get("codexPath"),
                                          [previous.get("codex", {}).get("path", "")]):
            code, output = run([executable, "--version"], env)
            match = re.search(r"\bcodex-cli\s+(\S+)", output)
            if code == 0 and match:
                runtime["codex"] = {"path": executable, "version": match[1][:100]}
                break
        if not runtime["codex"]:
            errors.append({"code": "CODEX_REQUIRED", "message": "The genuine Codex CLI is required remotely for App transport; install @openai/codex or supply --codex-path"})
        return runtime, errors

    def processes(self, manifest=None):
        runtime = (manifest or {}).get("runtime", {})
        expected_node = runtime.get("node", {}).get("path")
        result = []
        if not self.proc.is_dir():
            return result
        release_root = self.root / "releases"
        for entry in self.proc.iterdir():
            if not entry.name.isdigit():
                continue
            try:
                if entry.stat().st_uid != os.getuid():
                    continue
                args = [v.decode("utf-8", "strict") for v in (entry / "cmdline").read_bytes().split(b"\0") if v]
                environment = dict(v.split(b"=", 1) for v in (entry / "environ").read_bytes().split(b"\0") if b"=" in v)
                if environment.get(b"CODEX_HOME") != str(self.profile_home).encode() or "app-server" not in args:
                    continue
                if expected_node and Path(args[0]).resolve() != Path(expected_node).resolve():
                    continue
                app_index = args.index("app-server")
                if "proxy" in args[app_index + 1:] or "daemon" in args[app_index + 1:]:
                    continue
                scripts = [Path(arg) for arg in args[1:app_index] if arg.endswith("/cli.mjs")]
                if len(scripts) != 1 or not inside(scripts[0], release_root):
                    continue
                # proc stat field 22, after the last ')' in a possibly spaced comm.
                start_time = (entry / "stat").read_text().rsplit(")", 1)[1].split()[19]
                result.append({"pid": int(entry.name), "startTime": start_time, "script": str(scripts[0])})
            except (OSError, ValueError, UnicodeError, IndexError):
                continue
        return result

    def busy(self, running):
        if not running:
            return False, []
        count = 0
        for record in (self.profile_home / "cursor-bridge").glob("*.json"):
            try:
                data = json.loads(record.read_text())
                turns = data.get("thread", {}).get("turns", [])
                if any(turn.get("status") == "inProgress" for turn in turns):
                    count += 1
            except (OSError, ValueError, AttributeError, TypeError):
                return True, [{"code": "BUSY_STATE_UNKNOWN", "message": "Cannot safely verify bridge activity; close its App connection and retry"}]
        return count > 0, ([{"code": "BRIDGE_BUSY", "message": "Wait for active Cursor replies before upgrading or uninstalling"}] if count else [])

    def probe(self):
        manifest = self.read_manifest()
        runtime, errors = self.runtime((manifest or {}).get("runtime"))
        if self.system != "Linux":
            errors.insert(0, {"code": "LINUX_REQUIRED", "message": "This version supports Linux development machines"})
        running = self.processes(manifest)
        busy, activity_errors = self.busy(running)
        return {"platform": self.system, "home": str(self.home), "shell": os.environ.get("SHELL", ""),
                "python": {"path": sys.executable, "version": platform.python_version()},
                "runtime": runtime, "paths": self.paths(), "installed": bool(manifest),
                "version": (manifest or {}).get("version"), "config": manifest,
                "activationEnv": self.activation_env,
                "ready": not errors, "errors": errors, "running": running,
                "busy": busy, "activityErrors": activity_errors, "health": self.health(manifest)}

    def wrapper_bytes(self):
        return ("\n".join(["#!/bin/sh", "# " + OWNER + " " + self.id,
                             "if [ -f " + shlex.quote(str(self.maintenance)) + " ]; then",
                             "  echo 'cursor-codex-bridge is being maintained; reconnect shortly' >&2", "  exit 75", "fi",
                             "exec " + shlex.quote(str(self.current / "launch.sh")) + " \"$@\"", ""])).encode()

    def launch_bytes(self, release, runtime):
        node = runtime["node"]["path"]
        return ("\n".join(["#!/bin/sh", "export CODEX_HOME=" + shlex.quote(str(self.profile_home)),
                             "export CURSOR_BRIDGE_REAL_CODEX=" + shlex.quote(runtime["codex"]["path"]),
                             "export CURSOR_BRIDGE_AGENT=" + shlex.quote(runtime["agent"]["path"]),
                             "export CURSOR_BRIDGE_MAINTENANCE_FILE=" + shlex.quote(str(self.maintenance)),
                             "export PATH=" + shlex.quote(str(Path(node).parent)) + ":\"$PATH\"",
                             "exec " + shlex.quote(node) + " " + shlex.quote(str(release / "cli.mjs")) + " \"$@\"", ""])).encode()

    def health(self, manifest):
        errors = []
        def issue(code, message):
            errors.append({"code": code, "message": message})
        if not manifest:
            return {"ok": False, "errors": [{"code": "NOT_INSTALLED", "message": "No installation metadata was found"}]}
        try:
            self.assert_owner()
            release = safe_path(manifest.get("release"))
            if release.parent != self.root / "releases" or release.is_symlink() or not release.is_dir() or not inside(release, self.root / "releases"):
                raise InstallError("RELEASE_INVALID", "Saved release is not an owned release directory")
            if release.stat().st_uid != os.getuid():
                raise InstallError("RELEASE_INVALID", "Saved release belongs to a different user")
            if not self.current.is_symlink() or self.current.resolve() != release.resolve():
                issue("CURRENT_INVALID", "Current symlink does not point to the saved release")
            checks = [(self.root / "bin/codex", True, self.wrapper_bytes()),
                      (release / "launch.sh", True, self.launch_bytes(release, manifest["runtime"]))]
            checks += [(release / name, False, None) for name in ["cli.mjs", "bridge.mjs", "package.json",
                       "node_modules/ws/package.json", "node_modules/ws/wrapper.mjs",
                       "node_modules/wrap-ansi/package.json", "node_modules/wrap-ansi/index.js"]]
            for path, executable, contents in checks:
                if (not path.is_file() or path.is_symlink() or not inside(path, self.root)
                        or path.stat().st_uid != os.getuid() or not os.access(path, os.R_OK)
                        or (executable and not os.access(path, os.X_OK))):
                    issue("RUNTIME_FILE_INVALID", "Missing, unreadable or unowned runtime file: " + str(path))
                elif contents is not None and path.read_bytes() != contents:
                    issue("RUNTIME_FILE_MODIFIED", "Managed launcher differs from installation metadata: " + str(path))
            for entry in manifest.get("profiles", []):
                contents, _ = self.profile_content(safe_path(entry["path"]))
                _, block = self.split_block(contents)
                if block is None or digest(block) != entry.get("blockSha256"):
                    issue("PROFILE_BLOCK_INVALID", "Managed login profile block is missing or modified: " + entry["path"])
            if self.maintenance.exists():
                issue("MAINTENANCE_ACTIVE", "Installation maintenance marker is present")
        except InstallError as error:
            issue(error.code, str(error))
        except (OSError, KeyError, TypeError, ValueError):
            issue("INSTALLATION_INVALID", "Installation files or metadata could not be verified")
        return {"ok": not errors, "errors": errors}

    def block_markers(self):
        label = OWNER + ":" + self.id
        return "# >>> " + label + " >>>", "# <<< " + label + " <<<"

    def profile_block(self, runtime):
        start, end = self.block_markers()
        exports = {"CODEX_HOME": str(self.profile_home), "CODEX_INSTALL_DIR": str(self.root / "bin"),
                   "CURSOR_BRIDGE_REAL_CODEX": runtime["codex"]["path"],
                   "CURSOR_BRIDGE_AGENT": runtime["agent"]["path"]}
        lines = [start, "# Managed by cursor-codex-bridge; active only for its dedicated SSH connection.",
                 "if [ \"${" + self.activation_env + "-}\" = " + shlex.quote(str(self.profile_home)) + " ]; then"]
        lines += ["  export " + key + "=" + shlex.quote(value) for key, value in exports.items()]
        path_prefix = str(self.root / "bin") + ":" + str(Path(runtime["node"]["path"]).parent)
        lines += ["  export PATH=" + shlex.quote(path_prefix) + ":\"$PATH\"", "fi", end]
        return ("\n".join(lines) + "\n").encode()

    def profile_paths(self):
        bash_profile = next((self.home / name for name in [".bash_profile", ".bash_login", ".profile"]
                             if (self.home / name).exists()), self.home / ".profile")
        zdir = os.environ.get("ZDOTDIR")
        zroot = Path(zdir) if zdir and Path(zdir).is_absolute() and inside(Path(zdir), self.home) else self.home
        return [bash_profile, zroot / ".zprofile"]

    def profile_content(self, path):
        if not inside(path, self.home):
            raise InstallError("UNSAFE_PROFILE", "Login profile resolves outside the remote home")
        if path.exists():
            if not path.is_file() or path.stat().st_uid != os.getuid():
                raise InstallError("UNSAFE_PROFILE", "Login profile must be a regular file owned by the remote user")
            return path.read_bytes(), stat.S_IMODE(path.stat().st_mode)
        return b"", 0o644

    def split_block(self, contents):
        start, end = (value.encode() for value in self.block_markers())
        lines = contents.splitlines(keepends=True)
        starts = [i for i, line in enumerate(lines) if line.rstrip(b"\r\n") == start]
        ends = [i for i, line in enumerate(lines) if line.rstrip(b"\r\n") == end]
        if not starts and not ends:
            return contents, None
        if len(starts) != 1 or len(ends) != 1 or starts[0] >= ends[0]:
            raise InstallError("PROFILE_MARKERS_INVALID", "Login profile has ambiguous bridge markers; resolve them before continuing")
        before = b"".join(lines[:starts[0]])
        block = b"".join(lines[starts[0]:ends[0] + 1])
        after = b"".join(lines[ends[0] + 1:])
        # A separator added by us is part of the stored block, leaving user bytes intact.
        return before + after, block

    def remove_block(self, contents, metadata=None):
        without, block = self.split_block(contents)
        if block is None:
            return without, None
        # Remove our one-byte separator only when the exact prefix ownership proof
        # still matches. Unrelated user edits never authorize deleting a newline.
        metadata = metadata or {}
        offset = contents.index(block)
        prefix, suffix = contents[:offset], contents[offset + len(block):]
        if (metadata.get("addedSeparator") and prefix.endswith(b"\n")
                and digest(prefix[:-1]) == metadata.get("separatorPrefixSha256")):
            without = prefix[:-1] + suffix
        return without, block

    def prepare_profiles(self, runtime, manifest):
        saved = {entry["path"]: entry for entry in (manifest or {}).get("profiles", [])}
        paths = list(dict.fromkeys(list(saved) + [str(p) for p in self.profile_paths()]))
        block = self.profile_block(runtime)
        changes = []
        for name in paths:
            path = safe_path(name)
            old, mode = self.profile_content(path)
            metadata = saved.get(name)
            without, old_block = self.remove_block(old, metadata)
            if old_block is not None and (not metadata or digest(old_block) != metadata.get("blockSha256")):
                raise InstallError("PROFILE_MODIFIED", "A managed profile block was changed outside the installer: " + name)
            separator = b"" if not without or without.endswith(b"\n") else b"\n"
            updated = without + separator + block
            changes.append({"path": path, "old": old, "new": updated, "mode": mode,
                            "metadata": {"path": name, "schemaVersion": SCHEMA,
                                         "originalSha256": (metadata or {}).get("originalSha256", digest(old)),
                                         "beforeSha256": digest(old), "installedSha256": digest(updated),
                                         "blockSha256": digest(block), "addedSeparator": bool(separator),
                                         "separatorPrefixSha256": digest(without) if separator else None}})
        return changes

    def extract(self, archive, destination):
        archive = safe_path(archive)
        if not archive.is_file() or archive.is_symlink() or archive.stat().st_uid != os.getuid() or archive.stat().st_size > MAX_ARCHIVE:
            raise InstallError("INVALID_ARCHIVE", "Runtime archive must be an owned regular file of at most 128 MiB")
        total = 0
        try:
            with tarfile.open(str(archive), "r:gz") as bundle:
                members = bundle.getmembers()
                if len(members) > 20000:
                    raise InstallError("INVALID_ARCHIVE", "Runtime archive has too many entries")
                for member in members:
                    name = PurePosixPath(member.name)
                    if name.is_absolute() or ".." in name.parts or not (member.isfile() or member.isdir()):
                        raise InstallError("INVALID_ARCHIVE", "Runtime archive contains an unsafe path or link")
                    total += member.size
                    if total > MAX_CONTENTS:
                        raise InstallError("INVALID_ARCHIVE", "Unpacked runtime exceeds 512 MiB")
                for member in members:
                    target = destination.joinpath(*PurePosixPath(member.name).parts)
                    if member.isdir():
                        target.mkdir(parents=True, exist_ok=True, mode=0o700)
                    else:
                        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                        source = bundle.extractfile(member)
                        with source, target.open("xb") as out:
                            shutil.copyfileobj(source, out)
                        os.chmod(target, 0o700 if member.mode & 0o111 else 0o600)
        except (tarfile.TarError, OSError) as error:
            raise InstallError("INVALID_ARCHIVE", "Cannot safely unpack runtime: " + type(error).__name__)
        for required in ["cli.mjs", "bridge.mjs", "package.json", "node_modules/ws/package.json", "node_modules/wrap-ansi/package.json"]:
            if not (destination / required).is_file():
                raise InstallError("INCOMPLETE_RUNTIME", "Runtime archive is missing " + required)

    def quiesce(self, manifest):
        if not manifest or manifest.get("maintenanceProtocol") != 1:
            raise InstallError("MAINTENANCE_UNSUPPORTED", "Close this bridge's App connection before upgrading or uninstalling its older version")
        if not self.maintenance.is_file():
            raise InstallError("MAINTENANCE_REQUIRED", "Maintenance marker must exist before checking the running bridge")
        node = manifest.get("runtime", {}).get("node", {}).get("path")
        if not node or not Path(node).is_file() or not os.access(node, os.X_OK):
            raise InstallError("MAINTENANCE_RUNTIME_MISSING", "Cannot contact the running bridge without its saved Node runtime; close its App connection first")
        release = safe_path(manifest.get("release"))
        if release.parent != self.root / "releases" or not inside(release, self.root / "releases"):
            raise InstallError("INVALID_INSTALLATION", "Saved maintenance runtime is outside the installation")
        module_path = release / "node_modules/ws/wrapper.mjs"
        socket = self.profile_home / "app-server-control/app-server-control.sock"
        script = r'''
import net from 'node:net';
import { pathToFileURL } from 'node:url';
const [socketPath, modulePath] = process.argv.slice(1);
let ws, finished = false;
const finish = (reason, idle = false) => {
  if (finished) return;
  finished = true;
  console.log(JSON.stringify({ idle, reason }));
  clearTimeout(timer);
  ws?.terminate();
};
const timer = setTimeout(() => finish('TIMEOUT'), 4500);
try {
  const { WebSocket } = await import(pathToFileURL(modulePath).href);
  ws = new WebSocket('ws://localhost', {
    createConnection: () => net.createConnection(socketPath),
    handshakeTimeout: 4000, maxPayload: 65536,
  });
  ws.on('open', () => ws.send(JSON.stringify({id:1,method:'initialize',params:{
    clientInfo:{name:'cursor-codex-bridge-installer',version:'0.1.0'},
    capabilities:{experimentalApi:true},
  }})));
  ws.on('message', raw => {
    let message;
    try { message = JSON.parse(raw.toString()); } catch { return; }
    if (message.id === 1) {
      if (message.error) return finish('INITIALIZE_FAILED');
      ws.send(JSON.stringify({method:'initialized',params:{}}));
      ws.send(JSON.stringify({id:2,method:'cursorBridge/maintenance',params:{}}));
    } else if (message.id === 2) {
      if (message.error) return finish(message.error.code === -32002 ? 'BUSY' : 'UNSUPPORTED');
      finish(message.result?.idle === true ? 'IDLE' : 'NOT_IDLE', message.result?.idle === true);
    }
  });
  ws.on('error', () => finish('CONNECTION_FAILED'));
  ws.on('close', () => finish('CLOSED'));
} catch { finish('RUNTIME_FAILED'); }
'''
        code, output = run([node, "--input-type=module", "-e", script, str(socket), str(module_path)], timeout=5)
        try:
            answer = json.loads(output)
        except (ValueError, TypeError):
            answer = {}
        if code != 0 or answer.get("idle") is not True:
            if answer.get("reason") == "BUSY":
                raise InstallError("BRIDGE_BUSY", "The running bridge has an active request; wait for it to finish")
            raise InstallError("MAINTENANCE_NOT_CONFIRMED", "The running bridge could not confirm it is idle; close this bridge's App connection and retry")

    def stop_owned(self, manifest):
        running = self.processes(manifest)
        if not running:
            return
        busy, errors = self.busy(running)
        if busy:
            raise InstallError(errors[0]["code"], errors[0]["message"])
        self.quiesce(manifest)
        # Disk activity is rechecked after the in-memory RPC barrier.
        busy, errors = self.busy(self.processes(manifest))
        if busy:
            raise InstallError(errors[0]["code"], errors[0]["message"])
        for process in running:
            # Re-verify PID, start time, executable, script and dedicated CODEX_HOME.
            if process not in self.processes(manifest):
                continue
            try:
                os.kill(process["pid"], signal.SIGTERM)
            except ProcessLookupError:
                pass
        deadline = time.monotonic() + 5
        while self.processes(manifest):
            if time.monotonic() >= deadline:
                raise InstallError("BRIDGE_STOP_TIMEOUT", "Owned bridge did not exit after SIGTERM; it was not force-killed")
            time.sleep(0.1)

    @contextlib.contextmanager
    def locked(self):
        lock = self.home / ".local/state" / OWNER / ("." + self.id + ".install.lock")
        lock.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        try:
            descriptor = os.open(lock, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            raise InstallError("INSTALL_LOCKED", "Another installer holds the lock: " + str(lock))
        try:
            os.write(descriptor, str(os.getpid()).encode())
            os.close(descriptor)
            yield
        finally:
            lock.unlink(missing_ok=True)

    def install(self):
        version = self.request.get("version")
        if not isinstance(version, str) or not VERSION.fullmatch(version):
            raise InstallError("INVALID_VERSION", "A safe package version is required")
        if not self.request.get("archivePath"):
            raise InstallError("ARCHIVE_REQUIRED", "archivePath is required")
        with self.locked():
            self.assert_owner()
            before = self.read_manifest()
            probe = self.probe()
            if not probe["ready"]:
                raise InstallError("RUNTIME_NOT_READY", "Remote prerequisites are not ready", probe["errors"])
            if probe["busy"]:
                raise InstallError("BRIDGE_BUSY", "Wait for active Cursor replies before upgrading")
            runtime = probe["runtime"]
            changes = self.prepare_profiles(runtime, before)
            self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
            atomic_write(self.marker_path, json_bytes({"owner": OWNER, "id": self.id, "schemaVersion": SCHEMA}))
            for name in ["releases", "bin", "backups"]:
                if (self.root / name).is_symlink():
                    raise InstallError("UNOWNED_PATH", "Managed directories must not be symbolic links: " + name)
            release = self.root / "releases" / (version + "-" + uuid.uuid4().hex[:12])
            release.mkdir(parents=True, mode=0o700)
            committed = False
            applied = []
            old_wrapper = (self.root / "bin/codex").read_bytes() if (self.root / "bin/codex").is_file() else None
            try:
                self.extract(self.request["archivePath"], release)
                node = runtime["node"]["path"]
                code, _ = run([node, "--check", str(release / "cli.mjs")])
                check = "await import(" + json.dumps(str(release / "node_modules/ws/wrapper.mjs")) + "); await import(" + json.dumps(str(release / "node_modules/wrap-ansi/index.js")) + ")"
                imports, _ = run([node, "--input-type=module", "-e", check])
                if code != 0 or imports != 0:
                    raise InstallError("RUNTIME_CHECK_FAILED", "Bundled Node runtime dependencies failed validation; current installation was not switched")
                atomic_write(release / "launch.sh", self.launch_bytes(release, runtime), 0o700)
                atomic_write(self.maintenance, b"maintenance\n")
                self.stop_owned(before)
                backup = self.root / "backups" / (datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8])
                backup.mkdir(parents=True, mode=0o700)
                for index, change in enumerate(changes):
                    path = change["path"]
                    if self.profile_content(path)[0] != change["old"]:
                        raise InstallError("PROFILE_CHANGED", "Login profile changed during installation: " + str(path))
                    atomic_write(backup / (str(index) + "-" + path.name), change["old"])
                    atomic_write(path.resolve() if path.is_symlink() else path, change["new"], change["mode"])
                    applied.append(change)
                atomic_write(self.root / "bin/codex", self.wrapper_bytes(), 0o700)
                self.profile_home.mkdir(parents=True, exist_ok=True, mode=0o700)
                now = datetime.datetime.now(datetime.timezone.utc).isoformat()
                result = {"owner": OWNER, "id": self.id, "schemaVersion": SCHEMA, "version": version,
                          "maintenanceProtocol": 1,
                          "activationEnv": self.activation_env,
                          "installedAt": (before or {}).get("installedAt", now), "updatedAt": now,
                          "runtime": runtime, "paths": self.paths(), "release": str(release),
                          "previousRelease": (before or {}).get("release"),
                          "profiles": [change["metadata"] for change in changes]}
                # Persist metadata before the final, atomic activation; restore it on failure.
                atomic_write(self.manifest_path, json_bytes(result))
                link = self.root / (".current-" + uuid.uuid4().hex)
                link.symlink_to(release.relative_to(self.root), target_is_directory=True)
                try:
                    os.replace(link, self.current)
                finally:
                    link.unlink(missing_ok=True)
                committed = True
                return {"installed": True, "version": version, "previousVersion": (before or {}).get("version"),
                        "activationEnv": self.activation_env,
                        "paths": self.paths(), "runtime": runtime, "profiles": result["profiles"],
                        "statePreserved": True, "reconnectRequired": True}
            finally:
                if not committed:
                    for change in reversed(applied):
                        if self.profile_content(change["path"])[0] == change["new"]:
                            atomic_write(change["path"].resolve() if change["path"].is_symlink() else change["path"], change["old"], change["mode"])
                    if old_wrapper is not None:
                        atomic_write(self.root / "bin/codex", old_wrapper, 0o700)
                    elif (self.root / "bin/codex").exists():
                        (self.root / "bin/codex").unlink()
                    if before:
                        atomic_write(self.manifest_path, json_bytes(before))
                    else:
                        self.manifest_path.unlink(missing_ok=True)
                    shutil.rmtree(release, ignore_errors=True)
                self.maintenance.unlink(missing_ok=True)

    def uninstall(self):
        with self.locked():
            self.assert_owner()
            manifest = self.read_manifest()
            if not manifest:
                return {"installed": False, "statePreserved": True, "paths": self.paths()}
            changes = []
            for entry in manifest.get("profiles", []):
                path = safe_path(entry["path"])
                old, mode = self.profile_content(path)
                without, block = self.remove_block(old, entry)
                if block and digest(block) != entry.get("blockSha256"):
                    raise InstallError("PROFILE_MODIFIED", "Managed profile block changed; refusing to remove it: " + str(path))
                changes.append((path, old, without, mode))
            atomic_write(self.maintenance, b"maintenance\n")
            try:
                self.stop_owned(manifest)
                for path, old, without, mode in changes:
                    if self.profile_content(path)[0] != old:
                        raise InstallError("PROFILE_CHANGED", "Login profile changed during uninstall: " + str(path))
                    atomic_write(path.resolve() if path.is_symlink() else path, without, mode)
                # State is a sibling directory and is deliberately not removed.
                shutil.rmtree(self.root)
                return {"installed": False, "statePreserved": True, "paths": self.paths(), "reconnectRequired": True}
            finally:
                self.maintenance.unlink(missing_ok=True)


def main():
    action = sys.argv[1] if len(sys.argv) == 2 else ""
    try:
        if sys.version_info < (3, 8):
            raise InstallError("PYTHON_VERSION_REQUIRED", "Python 3.8 or newer is required on the development machine")
        if action not in {"probe", "read", "status", "install", "uninstall"}:
            raise InstallError("INVALID_ACTION", "Expected probe, read, status, install or uninstall")
        request = json.load(sys.stdin)
        if not isinstance(request, dict):
            raise InstallError("INVALID_REQUEST", "stdin must contain one JSON object")
        remote = Remote(request)
        if action in {"probe", "status"}:
            result = remote.probe()
        elif action == "read":
            manifest = remote.read_manifest()
            result = {"installed": bool(manifest), "config": manifest, "paths": remote.paths(), "activationEnv": remote.activation_env}
        else:
            result = getattr(remote, action)()
        print(json.dumps({"ok": True, "action": action, **result}, ensure_ascii=False))
    except InstallError as error:
        result = {"ok": False, "action": action, "error": {"code": error.code, "message": str(error)}}
        if error.details is not None:
            result["error"]["details"] = error.details
        print(json.dumps(result, ensure_ascii=False))
        return 1
    except (OSError, ValueError, TypeError) as error:
        print(json.dumps({"ok": False, "action": action, "error": {"code": "INSTALLER_ERROR", "message": str(error)}}))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
