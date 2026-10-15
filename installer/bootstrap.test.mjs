import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Injected HTTPS archives and tiny shell executables keep these tests offline.
const pythonTests = String.raw`
import base64
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('runtime_bootstrap', sys.argv[1])
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)

def archive(entries):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w:gz') as bundle:
        for name, content in entries:
            member = tarfile.TarInfo(name)
            if isinstance(content, tuple):
                member.type, member.linkname = content
                bundle.addfile(member)
            else:
                member.size = len(content)
                bundle.addfile(member, io.BytesIO(content))
    return output.getvalue()

def executable(version):
    return ('#!/bin/sh\n[ "$#" = 1 ] && [ "$1" = --version ] || exit 97\nprintf "%s\\n" "' + version + '"\n').encode()

class BootstrapTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="bridge bootstrap ' ")
        self.home = Path(self.temporary.name)
        self.urls, self.fetched, self.executed = {}, [], []
        self.archives('x64')

    def tearDown(self):
        self.temporary.cleanup()

    def archives(self, arch, node_entries=None, codex_entries=None):
        node_root = 'node-v' + runtime.NODE_VERSION + '-linux-' + arch
        node_file = node_root + '.tar.gz'
        node_base = 'https://nodejs.org/dist/v' + runtime.NODE_VERSION + '/'
        self.node_url = node_base + node_file
        self.node_entries = node_entries or [(node_root + '/bin/node', executable('v' + runtime.NODE_VERSION)),
            (node_root + '/LICENSE', b'Node license fixture'),
            (node_root + '/bin/npm', (tarfile.SYMTYPE, '../lib/node_modules/npm/bin/npm-cli.js'))]
        self.urls[self.node_url] = archive(self.node_entries)
        self.urls[node_base + 'SHASUMS256.txt'] = (hashlib.sha256(self.urls[self.node_url]).hexdigest() + '  ' + node_file + '\n').encode()
        triple = 'x86_64-unknown-linux-musl' if arch == 'x64' else 'aarch64-unknown-linux-musl'
        self.codex_prefix = 'package/vendor/' + triple + '/'
        self.codex_url = 'https://registry.npmjs.org/@openai/codex/-/codex-' + runtime.CODEX_VERSION + '-linux-' + arch + '.tgz'
        self.metadata_url = 'https://registry.npmjs.org/@openai%2fcodex/' + runtime.CODEX_VERSION + '-linux-' + arch
        self.codex_entries = codex_entries or [
            (self.codex_prefix + 'bin/codex', executable('codex-cli ' + runtime.CODEX_VERSION)),
            (self.codex_prefix + 'bin/codex-code-mode-host', b'not invoked'),
            (self.codex_prefix + 'codex-path/rg', b'not invoked'),
            (self.codex_prefix + 'codex-resources/bwrap', b'not invoked'),
            (self.codex_prefix + 'codex-resources/voice/lib/unneeded', b'not installed'),
            ('package/LICENSE', b'Codex license fixture')]
        self.urls[self.codex_url] = archive(self.codex_entries)
        self.metadata = {'dist': {'tarball': self.codex_url,
            'integrity': 'sha512-' + base64.b64encode(hashlib.sha512(self.urls[self.codex_url]).digest()).decode()}}
        self.urls[self.metadata_url] = json.dumps(self.metadata).encode()

    def fetch(self, url, limit):
        self.fetched.append(url)
        self.assertIn(url, self.urls, 'No test may access the real network')
        return self.urls[url]

    def checked_run(self, arguments):
        self.executed.append(arguments)
        self.assertEqual(arguments[1:], ['--version'], 'No runtime/model operation other than --version is allowed')
        return runtime.version_command(arguments)

    def subject(self, **options):
        return runtime.Bootstrap(home=self.home, system='Linux', machine='x86_64', fetch=self.fetch, run=self.checked_run, **options)

    def assert_error(self, code, action):
        with self.assertRaises(runtime.BootstrapError) as result:
            action()
        self.assertEqual(result.exception.code, code)

    def request(self, **options):
        return dict(needNode=True, needCodex=True, **options)

    def test_installs_verified_pinned_user_runtimes_without_npm(self):
        result = self.subject().execute(self.request())
        self.assertEqual(result['installed'], ['node', 'codex'])
        self.assertTrue(result['ok'])
        self.assertEqual(result['paths']['nodePath'], str(self.home / '.local/share/cursor-codex-bridge/runtimes/node-v22.23.1-linux-x64/bin/node'))
        self.assertEqual(result['paths']['codexPath'], str(self.home / '.local/share/cursor-codex-bridge/runtimes/codex-0.160.0-linux-x64/bin/codex'))
        for path in result['paths'].values():
            self.assertEqual(Path(path).stat().st_mode & 0o777, 0o700)
            version_root = Path(path).parent.parent
            self.assertTrue((version_root / 'THIRD-PARTY-NOTICES').is_file())
            self.assertEqual((version_root / '.owner.json').stat().st_mode & 0o777, 0o600)
            self.assertFalse((version_root / 'bin/npm').exists())
            self.assertFalse(list(version_root.rglob('unneeded')))
        self.assertEqual(len(self.fetched), 4)
        self.assertEqual(len(self.executed), 2)

    def test_cached_runtimes_do_not_download_or_replace_files(self):
        subject = self.subject()
        first = subject.execute(self.request())
        before = {path: Path(path).stat().st_ino for path in first['paths'].values()}
        self.fetched.clear()
        second = self.subject().execute(self.request())
        self.assertEqual(second['installed'], [])
        self.assertEqual(second['paths'], first['paths'])
        self.assertEqual(self.fetched, [])
        self.assertEqual({path: Path(path).stat().st_ino for path in second['paths'].values()}, before)

    def test_preserves_existing_compatible_node(self):
        existing = self.home / 'existing node'
        existing.write_bytes(executable('v24.1.0')); existing.chmod(0o700)
        result = self.subject().execute({'needNode': True, 'needCodex': False, 'nodePath': str(existing)})
        self.assertEqual(result, {'ok': True, 'paths': {'nodePath': str(existing)}, 'installed': []})
        self.assertEqual(self.fetched, [])
        self.assertFalse((self.home / '.local').exists())

    def test_replaces_no_existing_binary_when_old_node_requires_bootstrap(self):
        existing = self.home / 'old node'
        content = executable('v20.0.0'); existing.write_bytes(content); existing.chmod(0o700)
        result = self.subject().execute({'needNode': True, 'needCodex': False, 'nodePath': str(existing)})
        self.assertEqual(result['installed'], ['node'])
        self.assertNotEqual(result['paths']['nodePath'], str(existing))
        self.assertEqual(existing.read_bytes(), content)

    def test_arm64_uses_the_official_arm64_package(self):
        self.archives('arm64')
        subject = runtime.Bootstrap(home=self.home, machine='aarch64', system='Linux', fetch=self.fetch, run=self.checked_run)
        result = subject.execute(self.request())
        self.assertTrue(result['paths']['nodePath'].endswith('linux-arm64/bin/node'))
        self.assertIn('0.160.0-linux-arm64', self.fetched[2])
        self.assertTrue(list(Path(result['paths']['codexPath']).parent.parent.rglob('aarch64-unknown-linux-musl')))

    def test_refuses_node_checksum_mismatch_before_any_execution(self):
        self.urls[self.node_url] += b'tampered'
        self.assert_error('CHECKSUM_MISMATCH', lambda: self.subject().execute(self.request()))
        self.assertEqual(self.executed, [])
        self.assertFalse(list((self.home / '.local/share/cursor-codex-bridge/runtimes').glob('node-*')))

    def test_refuses_codex_integrity_mismatch_before_execution(self):
        self.urls[self.codex_url] += b'tampered'
        self.assert_error('CHECKSUM_MISMATCH', lambda: self.subject().execute({'needNode': False, 'needCodex': True}))
        self.assertEqual(self.executed, [])

    def test_refuses_untrusted_metadata_tarball_urls(self):
        for url in ['http://registry.npmjs.org/file', 'https://evil.example/file',
                    'https://registry.npmjs.org@evil.example/file', 'https://registry.npmjs.org:444/file']:
            with self.subTest(url=url):
                self.metadata['dist']['tarball'] = url
                self.urls[self.metadata_url] = json.dumps(self.metadata).encode()
                self.assert_error('DOWNLOAD_URL', lambda: self.subject().execute({'needNode': False, 'needCodex': True}))
                self.assertNotIn(url, self.fetched)

    def test_refuses_bad_integrity_metadata(self):
        for integrity in ['sha1-AAAA', 'sha512-AAAA', 'sha512-!', None]:
            with self.subTest(integrity=integrity):
                self.metadata['dist']['integrity'] = integrity
                self.urls[self.metadata_url] = json.dumps(self.metadata).encode()
                self.assert_error('CHECKSUM_METADATA', lambda: self.subject().execute({'needNode': False, 'needCodex': True}))

    def test_refuses_unsafe_tar_paths_even_for_ignored_members(self):
        for unsafe in ['../../outside', '/tmp/absolute', 'package/../../outside', 'package\\outside']:
            with self.subTest(path=unsafe):
                self.archives('x64', codex_entries=self.codex_entries + [(unsafe, b'bad')])
                self.assert_error('ARCHIVE_PATH', lambda: self.subject().execute({'needNode': False, 'needCodex': True}))
                self.assertFalse((self.home / 'outside').exists())

    def test_refuses_selected_symlinks_hardlinks_and_duplicate_members(self):
        name = self.codex_prefix + 'bin/codex'
        for content in [(tarfile.SYMTYPE, '/bin/sh'), (tarfile.LNKTYPE, '/bin/sh')]:
            with self.subTest(kind=content[0]):
                self.archives('x64', codex_entries=[(name, content)])
                self.assert_error('ARCHIVE_TYPE', lambda: self.subject().execute({'needNode': False, 'needCodex': True}))
        self.archives('x64', codex_entries=[(name, b'one'), (name, b'two')])
        self.assert_error('ARCHIVE_TYPE', lambda: self.subject().execute({'needNode': False, 'needCodex': True}))

    def test_refuses_missing_archive_members(self):
        self.archives('x64', codex_entries=[(self.codex_prefix + 'bin/codex', b'present')])
        self.assert_error('ARCHIVE_MISSING', lambda: self.subject().execute({'needNode': False, 'needCodex': True}))
        self.assertEqual(self.executed, [])

    def test_refuses_wrong_downloaded_node_version_without_publishing(self):
        name = 'node-v' + runtime.NODE_VERSION + '-linux-x64/bin/node'
        self.archives('x64', node_entries=[(name, executable('v23.0.0'))])
        self.assert_error('RUNTIME_VERSION', lambda: self.subject().execute({'needNode': True, 'needCodex': False}))
        self.assertFalse(list((self.home / '.local/share/cursor-codex-bridge/runtimes').glob('node-*')))

    def test_refuses_unowned_or_modified_cached_directories(self):
        result = self.subject().execute(self.request())
        node_root = Path(result['paths']['nodePath']).parent.parent
        marker = node_root / '.owner.json'
        data = json.loads(marker.read_text()); data['owner'] = 'someone-else'
        marker.write_text(json.dumps(data))
        self.fetched.clear()
        self.assert_error('RUNTIME_OWNERSHIP', lambda: self.subject().execute(self.request()))
        self.assertEqual(self.fetched, [])
        self.assertTrue(Path(result['paths']['codexPath']).exists())

    def test_refuses_symlinked_runtime_parent(self):
        external = self.home / 'external'; external.mkdir()
        (self.home / '.local').symlink_to(external, target_is_directory=True)
        self.assert_error('RUNTIME_OWNERSHIP', lambda: self.subject().execute(self.request()))
        self.assertEqual(list(external.iterdir()), [])

    def test_refuses_non_private_lock_without_fetching(self):
        subject = self.subject(); subject._prepare_root()
        lock = subject.root / '.bootstrap.lock'; lock.write_text(''); lock.chmod(0o644)
        self.assert_error('RUNTIME_OWNERSHIP', lambda: subject.execute(self.request()))
        self.assertEqual(self.fetched, [])

    def test_refuses_symlinked_lock_without_touching_its_target(self):
        subject = self.subject(); subject._prepare_root()
        external = self.home / 'keep'; external.write_text('keep')
        (subject.root / '.bootstrap.lock').symlink_to(external)
        self.assert_error('RUNTIME_OWNERSHIP', lambda: subject.execute(self.request()))
        self.assertEqual(external.read_text(), 'keep')
        self.assertEqual(self.fetched, [])

    def test_never_adopts_an_unmarked_existing_runtime_directory(self):
        subject = self.subject(); subject.root.mkdir(parents=True, mode=0o700)
        sentinel = subject.root / 'keep'; sentinel.write_text('keep')
        self.assert_error('RUNTIME_OWNERSHIP', lambda: subject.execute(self.request()))
        self.assertEqual(sentinel.read_text(), 'keep')
        self.assertFalse((subject.root / '.owner.json').exists())

    def test_invalid_cached_runtime_is_left_unchanged(self):
        result = self.subject().execute({'needNode': True, 'needCodex': False})
        path = Path(result['paths']['nodePath']); content = executable('wrong-version')
        path.write_bytes(content)
        self.fetched.clear()
        self.assert_error('RUNTIME_INVALID', lambda: self.subject().execute({'needNode': True, 'needCodex': False}))
        self.assertEqual(path.read_bytes(), content)
        self.assertEqual(self.fetched, [])

    def test_limits_unpacked_ignored_members_too(self):
        data = archive([('package/unselected', b'large-unselected-member')])
        with mock.patch.object(runtime, 'MAX_UNPACKED', 4):
            self.assert_error('ARCHIVE_SIZE', lambda: runtime.extract_selected(data, self.home, {}, []))

    def test_concurrent_installations_publish_once_and_reuse_cache(self):
        entered, release = threading.Event(), threading.Event()
        results, errors = [], []
        original_fetch = self.fetch
        def fetch(url, limit):
            entered.set()
            self.assertTrue(release.wait(3))
            return original_fetch(url, limit)
        def install():
            try:
                subject = runtime.Bootstrap(home=self.home, machine='x86_64', system='Linux', fetch=fetch, run=self.checked_run)
                results.append(subject.execute(self.request()))
            except BaseException as error:
                errors.append(error)
        first = threading.Thread(target=install); first.start()
        self.assertTrue(entered.wait(3))
        second = threading.Thread(target=install); second.start()
        time.sleep(0.1); release.set()
        first.join(5); second.join(5)
        self.assertFalse(first.is_alive() or second.is_alive())
        self.assertEqual(errors, [])
        self.assertEqual(sorted(len(value['installed']) for value in results), [0, 2])
        self.assertEqual(len(self.fetched), 4)

    def test_validates_request_and_platform_before_downloads(self):
        for request in [[], {}, {'needNode': 1, 'needCodex': False}, {'needNode': True, 'needCodex': False, 'nodePath': 'relative'}]:
            self.assert_error('INVALID_REQUEST', lambda: self.subject().execute(request))
        unsupported = runtime.Bootstrap(home=self.home, machine='x86_64', system='Darwin', fetch=self.fetch, run=self.checked_run)
        self.assert_error('UNSUPPORTED_PLATFORM', lambda: unsupported.execute(self.request()))
        self.assertEqual(self.fetched, [])

    def test_download_limits_and_redirect_allowlist(self):
        self.urls[self.node_url] = b'abc'
        self.assert_error('DOWNLOAD_SIZE', lambda: self.subject()._get(self.node_url, 2))
        handler = runtime.OfficialRedirects()
        self.assert_error('DOWNLOAD_URL', lambda: handler.redirect_request(None, None, 302, '', {}, 'https://evil.example/runtime'))

unittest.main(argv=['bootstrap-tests'], verbosity=2)
`;

test('pinned runtime bootstrap has offline integrity, ownership, portability, and concurrency coverage', { timeout: 30_000 }, async () => {
  const result = await promisify(execFile)(process.env.PYTHON || 'python3', [
    '-B', '-c', pythonTests, fileURLToPath(new URL('./bootstrap.py', import.meta.url)),
  ], { timeout: 28_000, maxBuffer: 1024 * 1024 });
  assert.match(result.stderr, /Ran 23 tests/);
  assert.match(result.stderr, /\nOK\s*$/);
});

test('bootstrap CLI rejects malformed requests with structured JSON and no runtime operation', async () => {
  let result;
  try {
    const execution = promisify(execFile)(process.env.PYTHON || 'python3', [
      '-B', fileURLToPath(new URL('./bootstrap.py', import.meta.url)),
    ], { timeout: 5_000 });
    execution.child.stdin.end();
    await execution;
    assert.fail('An empty bootstrap request must fail');
  } catch (error) {
    result = error;
  }
  assert.equal(result.code, 1);
  const body = JSON.parse(result.stdout);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'BOOTSTRAP_FAILED');
});
