#!/usr/bin/env python3
"""Install pinned, verified CLI runtimes in the current user's private directory.

JSON stdin/stdout. No package manager, sudo, Agent invocation, or model request.
Only explicitly selected regular archive members are written to disk.
"""

import base64
import contextlib
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.parse
import urllib.request


OWNER = "cursor-codex-bridge"
NODE_VERSION = "22.23.1"
CODEX_VERSION = "0.160.0"
MAX_DOWNLOAD = 256 * 1024 * 1024
MAX_UNPACKED = 512 * 1024 * 1024
HOSTS = frozenset(("nodejs.org", "registry.npmjs.org"))


class BootstrapError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def allowed_url(url):
    if not isinstance(url, str):
        raise BootstrapError("DOWNLOAD_URL", "Runtime download URLs must be strings")
    try:
        parsed = urllib.parse.urlsplit(url)
        valid = (parsed.scheme == "https" and parsed.hostname in HOSTS
                 and parsed.port in (None, 443) and parsed.username is None
                 and parsed.password is None and not parsed.fragment)
    except (ValueError, TypeError):
        valid = False
    if not valid:
        raise BootstrapError("DOWNLOAD_URL", "Runtime downloads require HTTPS on the official Node.js or npm registry host")
    return url


class OfficialRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        allowed_url(newurl)
        return super().redirect_request(request, fp, code, message, headers, newurl)


def fetch_https(url, limit=MAX_DOWNLOAD):
    allowed_url(url)
    opener = urllib.request.build_opener(OfficialRedirects())
    deadline = time.monotonic() + 180
    request = urllib.request.Request(url, headers={"User-Agent": OWNER + "/bootstrap", "Accept-Encoding": "identity"})
    with opener.open(request, timeout=30) as response:
        allowed_url(response.geturl())
        length = response.headers.get("Content-Length")
        if length and (not length.isdigit() or int(length) > limit):
            raise BootstrapError("DOWNLOAD_SIZE", "Runtime download exceeds its size limit")
        chunks, size = [], 0
        while True:
            if time.monotonic() > deadline:
                raise BootstrapError("DOWNLOAD_TIMEOUT", "Runtime download exceeded its time limit")
            chunk = response.read(min(1024 * 1024, limit - size + 1))
            if not chunk:
                break
            size += len(chunk)
            if size > limit:
                raise BootstrapError("DOWNLOAD_SIZE", "Runtime download exceeds its size limit")
            chunks.append(chunk)
        return b"".join(chunks)


def version_command(arguments):
    try:
        result = subprocess.run(arguments, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, timeout=20, check=False)
        return result.returncode, result.stdout[:4096].decode("utf-8", "replace")
    except (OSError, subprocess.TimeoutExpired):
        return -1, ""


def private_write(path, data, executable=False):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with path.open("xb") as stream:
        stream.write(data)
    path.chmod(0o700 if executable else 0o600)


def marker_bytes(value):
    return (json.dumps(value, sort_keys=True, indent=2) + "\n").encode()


def archive_name(name):
    parts = PurePosixPath(name).parts
    if not name or "\\" in name or "\x00" in name or name.startswith("/") or ".." in parts:
        raise BootstrapError("ARCHIVE_PATH", "Runtime archive contains an unsafe path")
    return "/".join(part for part in parts if part != ".")


def extract_selected(data, destination, selected, required):
    """Ignore unrelated members; never materialize a link, device, or tar path."""
    found, total, count = set(), 0, 0
    deadline = time.monotonic() + 180
    try:
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
            for member in archive:
                count += 1
                name = archive_name(member.name)
                total += member.size
                if member.size < 0 or total > MAX_UNPACKED or count > 100_000:
                    raise BootstrapError("ARCHIVE_SIZE", "Runtime archive exceeds its unpacked size or member limit")
                if time.monotonic() > deadline:
                    raise BootstrapError("ARCHIVE_TIMEOUT", "Runtime extraction exceeded its time limit")
                if name not in selected:
                    continue
                if name in found or not member.isfile() or member.size < 0:
                    raise BootstrapError("ARCHIVE_TYPE", "Selected runtime members must be unique regular files")
                relative, executable = selected[name]
                target = destination / relative
                target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                with archive.extractfile(member) as source, target.open("xb") as output:
                    remaining = member.size
                    while remaining:
                        if time.monotonic() > deadline:
                            raise BootstrapError("ARCHIVE_TIMEOUT", "Runtime extraction exceeded its time limit")
                        chunk = source.read(min(1024 * 1024, remaining))
                        if not chunk:
                            raise BootstrapError("ARCHIVE_TRUNCATED", "Runtime archive is incomplete")
                        output.write(chunk)
                        remaining -= len(chunk)
                target.chmod(0o700 if executable else 0o600)
                found.add(name)
    except (tarfile.TarError, EOFError) as error:
        raise BootstrapError("ARCHIVE_INVALID", "Runtime archive cannot be read") from error
    if not set(required).issubset(found):
        raise BootstrapError("ARCHIVE_MISSING", "Runtime archive is missing a required executable")


class Bootstrap:
    def __init__(self, home=None, machine=None, system=None, fetch=None, run=None):
        self.home = Path(home).absolute() if home is not None else Path.home()
        self.system = system or platform.system()
        self.machine = machine or platform.machine()
        self.fetch = fetch or fetch_https
        self.run = run or version_command
        self.root = self.home / ".local/share" / OWNER / "runtimes"

    def _arch(self):
        architecture = {"x86_64": "x64", "amd64": "x64", "x64": "x64",
                        "aarch64": "arm64", "arm64": "arm64"}.get(self.machine.lower())
        if self.system != "Linux" or not architecture:
            raise BootstrapError("UNSUPPORTED_PLATFORM", "Automatic runtimes support Linux x64 or arm64; provide existing executable paths on other platforms")
        return architecture

    def _get(self, url, limit=MAX_DOWNLOAD):
        allowed_url(url)
        data = self.fetch(url, limit)
        if not isinstance(data, bytes) or len(data) > limit:
            raise BootstrapError("DOWNLOAD_SIZE", "Runtime download is invalid or exceeds its size limit")
        return data

    def _check_path(self, path, directory=False):
        try:
            details = path.lstat()
        except FileNotFoundError:
            raise BootstrapError("RUNTIME_INVALID", "A managed runtime file is missing")
        expected = stat.S_ISDIR if directory else stat.S_ISREG
        if not expected(details.st_mode) or details.st_uid != os.getuid() or details.st_mode & 0o077:
            raise BootstrapError("RUNTIME_OWNERSHIP", "Managed runtimes must belong to the current user and must not be writable by others")

    def _read_marker(self, path, expected):
        try:
            self._check_path(path)
        except BootstrapError as error:
            raise BootstrapError("RUNTIME_OWNERSHIP", "Runtime ownership metadata is missing or unsafe") from error
        try:
            value = json.loads(path.read_text())
        except (ValueError, OSError) as error:
            raise BootstrapError("RUNTIME_OWNERSHIP", "Runtime ownership metadata is invalid") from error
        if any(value.get(key) != item for key, item in expected.items()):
            raise BootstrapError("RUNTIME_OWNERSHIP", "Refusing to replace a directory not owned by this runtime installer")

    def _prepare_root(self):
        current = self.home
        for part in (".local", "share", OWNER):
            current = current / part
            if current.is_symlink():
                raise BootstrapError("RUNTIME_OWNERSHIP", "Managed runtime parent directories must not be symlinks")
            current.mkdir(exist_ok=True, mode=0o700)
            if not current.is_dir() or current.stat().st_uid != os.getuid() or current.stat().st_mode & 0o022:
                raise BootstrapError("RUNTIME_OWNERSHIP", "Managed runtime parent directories are not private to the current user")
        created = False
        try:
            self.root.mkdir(mode=0o700)
            created = True
        except FileExistsError:
            pass
        self._check_path(self.root, directory=True)
        marker = self.root / ".owner.json"
        if created:
            private_write(marker, marker_bytes({"owner": OWNER, "schemaVersion": 1, "kind": "runtimes"}))
        else:
            # A concurrent creator writes the root marker before taking the lock.
            # Never adopt an unmarked directory, but allow that short creation gap.
            for _ in range(20):
                if marker.exists() or marker.is_symlink():
                    break
                time.sleep(0.05)
            self._read_marker(marker, {"owner": OWNER, "schemaVersion": 1, "kind": "runtimes"})

    @contextlib.contextmanager
    def _lock(self):
        self._prepare_root()
        path = self.root / ".bootstrap.lock"
        if path.is_symlink():
            raise BootstrapError("RUNTIME_OWNERSHIP", "Runtime lock must not be a symlink")
        descriptor = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
        try:
            details = os.fstat(descriptor)
            if not stat.S_ISREG(details.st_mode) or details.st_uid != os.getuid() or details.st_mode & 0o077 or details.st_nlink != 1:
                raise BootstrapError("RUNTIME_OWNERSHIP", "Runtime lock must be a private regular file")
            deadline = time.monotonic() + 60
            while True:
                try:
                    fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if time.monotonic() > deadline:
                        raise BootstrapError("RUNTIME_BUSY", "Another runtime installation is still active")
                    time.sleep(0.05)
            yield
        finally:
            fcntl.flock(descriptor, fcntl.LOCK_UN)
            os.close(descriptor)

    def _version(self, path, kind, pinned=None):
        code, output = self.run([str(path), "--version"])
        if code:
            return False
        if kind == "node":
            match = re.match(r"^v(\d+)\.\d+\.\d+(?:\s|$)", output.strip())
            return bool(match and int(match.group(1)) >= 22
                        and (pinned is None or output.strip() == "v" + pinned.lstrip("v")))
        return bool(re.search(r"(?:^|\n)codex-cli " + re.escape(CODEX_VERSION) + r"(?:\s|$)", output))

    def _cached(self, target, kind, version, arch):
        if not target.exists() and not target.is_symlink():
            return None
        self._check_path(target, directory=True)
        self._read_marker(target / ".owner.json", {"owner": OWNER, "schemaVersion": 1,
                          "kind": kind, "version": version, "arch": arch})
        path = target / "bin" / kind
        self._check_path(target / "bin", directory=True)
        self._check_path(path)
        if not self._version(path, kind, version):
            raise BootstrapError("RUNTIME_INVALID", "An existing managed runtime failed version validation; it was left unchanged")
        return str(path)

    def _install(self, kind, version, arch, builder):
        target = self.root / (kind + "-" + version + "-linux-" + arch)
        cached = self._cached(target, kind, version, arch)
        if cached:
            return cached, False
        temporary = Path(tempfile.mkdtemp(prefix="." + kind + "-", dir=self.root))
        try:
            sources = builder(temporary)
            if not self._version(temporary / "bin" / kind, kind, version):
                raise BootstrapError("RUNTIME_VERSION", "Downloaded runtime failed its version check; no installed runtime was replaced")
            private_write(temporary / ".owner.json", marker_bytes({"owner": OWNER, "schemaVersion": 1,
                          "kind": kind, "version": version, "arch": arch, "sources": sources}))
            os.rename(temporary, target)
            return str(target / "bin" / kind), True
        finally:
            if temporary.exists():
                shutil.rmtree(temporary)

    def _node(self, arch):
        filename = "node-v" + NODE_VERSION + "-linux-" + arch + ".tar.gz"
        base = "https://nodejs.org/dist/v" + NODE_VERSION + "/"

        def build(destination):
            checksums = self._get(base + "SHASUMS256.txt", 1024 * 1024).decode("ascii")
            expected = [line.split()[0] for line in checksums.splitlines()
                        if re.fullmatch(r"[a-fA-F0-9]{64}  \*?" + re.escape(filename), line)]
            if len(expected) != 1:
                raise BootstrapError("CHECKSUM_METADATA", "Official Node.js checksums do not uniquely identify the pinned archive")
            data = self._get(base + filename)
            if hashlib.sha256(data).hexdigest() != expected[0].lower():
                raise BootstrapError("CHECKSUM_MISMATCH", "Node.js archive SHA-256 verification failed")
            name = filename[:-7] + "/bin/node"
            license_name = filename[:-7] + "/LICENSE"
            extract_selected(data, destination, {name: ("bin/node", True), license_name: ("LICENSE", False)}, [name])
            private_write(destination / "THIRD-PARTY-NOTICES", ("Node.js " + NODE_VERSION + "\nOfficial source: " + base + filename + "\nChecksums: " + base + "SHASUMS256.txt\n").encode())
            return {"archive": base + filename, "sha256": expected[0].lower()}

        return self._install("node", "v" + NODE_VERSION, arch, build)

    def _codex(self, arch):
        metadata_url = "https://registry.npmjs.org/@openai%2fcodex/" + CODEX_VERSION + "-linux-" + arch
        triple = "x86_64-unknown-linux-musl" if arch == "x64" else "aarch64-unknown-linux-musl"
        prefix = "package/vendor/" + triple + "/"

        def build(destination):
            try:
                metadata = json.loads(self._get(metadata_url, 1024 * 1024))
                dist = metadata["dist"]
                url, integrity = dist["tarball"], dist["integrity"]
                match = re.fullmatch(r"sha512-([A-Za-z0-9+/]+={0,2})", integrity)
                expected = base64.b64decode(match.group(1), validate=True) if match else b""
                if len(expected) != 64:
                    raise ValueError()
            except (ValueError, KeyError, TypeError, AttributeError) as error:
                raise BootstrapError("CHECKSUM_METADATA", "Official Codex metadata has no valid SHA-512 integrity value") from error
            data = self._get(url)
            if hashlib.sha512(data).digest() != expected:
                raise BootstrapError("CHECKSUM_MISMATCH", "Codex archive SHA-512 verification failed")
            paths = ("bin/codex", "bin/codex-code-mode-host", "codex-path/rg", "codex-resources/bwrap")
            selected = {prefix + relative: ("vendor/" + triple + "/" + relative, True) for relative in paths}
            selected.update({"package/LICENSE": ("LICENSE", False), "package/LICENSE.md": ("LICENSE.md", False)})
            extract_selected(data, destination, selected, [prefix + "bin/codex", prefix + "codex-path/rg"])
            wrapper = ("#!/bin/sh\nruntime_dir=$(CDPATH= cd -P -- \"$(dirname -- \"$0\")/..\" && pwd) || exit 1\n"
                       "export PATH=\"$runtime_dir/vendor/" + triple + "/codex-path:$PATH\"\n"
                       "exec \"$runtime_dir/vendor/" + triple + "/bin/codex\" \"$@\"\n")
            private_write(destination / "bin/codex", wrapper.encode(), executable=True)
            private_write(destination / "THIRD-PARTY-NOTICES", ("OpenAI Codex CLI " + CODEX_VERSION + "\nOfficial package metadata: " + metadata_url + "\nOfficial archive: " + url + "\nUpstream source and license: https://github.com/openai/codex\nhttps://github.com/openai/codex/blob/main/LICENSE\nOnly the CLI, code mode host, ripgrep, and sandbox helper are selected; voice resources are not installed.\n").encode())
            return {"metadata": metadata_url, "archive": url, "integrity": integrity}

        return self._install("codex", CODEX_VERSION, arch, build)

    def execute(self, request):
        if not isinstance(request, dict) or any(type(request.get(key)) is not bool for key in ("needNode", "needCodex")):
            raise BootstrapError("INVALID_REQUEST", "needNode and needCodex must be booleans")
        existing = request.get("nodePath")
        if existing is not None and (not isinstance(existing, str) or not existing.startswith("/") or any(ord(c) < 32 for c in existing)):
            raise BootstrapError("INVALID_REQUEST", "nodePath must be an absolute executable path")
        paths, installed = {}, []
        if existing and self._version(existing, "node"):
            paths["nodePath"] = existing
        need_node = request["needNode"] and "nodePath" not in paths
        if not need_node and not request["needCodex"]:
            return {"ok": True, "paths": paths, "installed": installed}
        arch = self._arch()
        with self._lock():
            if need_node:
                path, changed = self._node(arch)
                paths["nodePath"] = path
                if changed:
                    installed.append("node")
            if request["needCodex"]:
                path, changed = self._codex(arch)
                paths["codexPath"] = path
                if changed:
                    installed.append("codex")
        return {"ok": True, "paths": paths, "installed": installed}


def main():
    try:
        data = sys.stdin.buffer.read(16 * 1024 + 1)
        if len(data) > 16 * 1024:
            raise BootstrapError("INVALID_REQUEST", "Bootstrap request exceeds its size limit")
        request = json.loads(data)
        result = Bootstrap().execute(request)
    except BootstrapError as error:
        result = {"ok": False, "error": {"code": error.code, "message": str(error)}}
    except Exception as error:
        result = {"ok": False, "error": {"code": "BOOTSTRAP_FAILED", "message": str(error)[:300]}}
    print(json.dumps(result))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
