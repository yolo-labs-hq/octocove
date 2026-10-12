"""Narrow scanner regression tests: exact exceptions and Git ref coverage."""
import base64
import contextlib
import io
import json
import os
import pathlib
import subprocess
import tempfile
import unittest
from unittest import mock
from classify import detector_sources, digest, disposition, fixture_key, load_patterns
from scan import HERE, main, scan_text

PATTERNS = load_patterns()
# The detectors in this repository: credential and identifier shapes only. A
# maintainer may add detectors for their own systems or hosts in an optional
# extra-patterns.json beside them.
GENERIC = {'token', 'jwt', 'hex32', 'email', 'secret_assignment', 'url_host', 'private_key',
           'other_token', 'account_literal', 'basic_auth', 'unprefixed_token'}


def setUpModule():
    # Fixture repositories are temporary directories of their own: a caller's repository or index must not
    # redirect their git commands.
    environ = mock.patch.dict(os.environ)
    environ.start()
    unittest.addModuleCleanup(environ.stop)
    for key in ('GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'):
        os.environ.pop(key, None)


class ScannerTests(unittest.TestCase):
    def scan(self, text, path='fixture.txt', fixtures=frozenset()):
        return scan_text(path, text.encode(), PATTERNS, fixtures)[0]

    def test_synthetic_token_requires_exact_review(self):
        text = '_'.join(('ghp', 'synthetic', 'scanner', 'negative', 'control'))
        hit = next(h for h in self.scan(text) if h['kind'] == 'token')
        self.assertEqual(hit['disposition'], 'redact')
        accepted = self.scan(text, fixtures={fixture_key(hit)})
        self.assertEqual(next(h for h in accepted if h['kind'] == 'token')['disposition'], 'allowlisted')
        self.assertEqual(next(h for h in self.scan(text + 'changed', fixtures={fixture_key(hit)}) if h['kind'] == 'token')['disposition'], 'redact')
        self.assertEqual(next(h for h in self.scan(text, path='other.txt', fixtures={fixture_key(hit)}) if h['kind'] == 'token')['disposition'], 'redact')
        self.assertEqual(next(h for h in self.scan('prefix ' + text, fixtures={fixture_key(hit)}) if h['kind'] == 'token')['disposition'], 'redact')

    def test_published_detectors_are_generic_and_private_rules_are_optional(self):
        self.assertEqual(set(json.loads((HERE / 'patterns.json').read_text())), GENERIC)
        with tempfile.TemporaryDirectory() as folder:
            (pathlib.Path(folder) / 'patterns.json').write_text((HERE / 'patterns.json').read_text())
            self.assertEqual(set(load_patterns(folder)), GENERIC)  # absent private file: generic set, no error
            (pathlib.Path(folder) / 'extra-patterns.json').write_text(json.dumps({'detectors': {'extra': 'x'}}))
            self.assertEqual(set(load_patterns(folder)), GENERIC | {'extra'})
            (pathlib.Path(folder) / 'extra-patterns.json').write_text(json.dumps({'detectors': {'email': 'x'}}))
            with self.assertRaisesRegex(ValueError, 'defined twice'):
                detector_sources(folder)

    def test_unknown_contact_fails(self):
        self.assertTrue(any(h['kind'] == 'email' and h['disposition'] == 'redact' for h in self.scan('contributor@' + 'personal.example.net')))
        self.assertFalse(any(h['disposition'] == 'redact' for h in self.scan('security@example.invalid https://git.example.invalid/repo')))

    def test_real_sized_account_is_not_a_dynamic_placeholder(self):
        text = 'accountId: "' + 'b' * 32 + '"'
        self.assertTrue(any(h['kind'] == 'account_literal' and h['disposition'] == 'redact' for h in self.scan(text)))
        self.assertEqual(next(h for h in self.scan('accountId: "<cf-account-id>"') if h['kind'] == 'account_literal')['disposition'], 'fine')

    # Credential-shaped fixtures are assembled at runtime so this file holds no literal match.
    def kinds(self, text):
        return {h['kind'] for h in self.scan(text) if h['disposition'] == 'redact'}

    def test_quoted_keys_basic_auth_and_new_prefixes_fail(self):
        body = 'Synth3ticValue' + 'Q' * 6
        encoded = base64.b64encode(('x-access-token:' + body).encode()).decode()
        cases = {
            '"api' + 'Token": "' + body + '"': 'secret_assignment',
            "{'pass" + "word': '" + body + "'}": 'secret_assignment',
            '"Author' + 'ization": "Bearer ' + body + '"': 'secret_assignment',
            'header Basic ' + base64.b64encode(('user:' + body).encode()).decode(): 'basic_auth',
            'logged ' + encoded: 'basic_auth',
            'oc' + 's_' + body: 'other_token',
            'cf ' + ('Ab1' + body + 'x' * 40)[:40]: 'unprefixed_token',
        }
        cases.update({'g' + 'h' + p + '_' + body: 'token' for p in 'opusr'})
        for text, kind in cases.items():
            self.assertIn(kind, self.kinds(text), kind)
        self.assertNotIn(body, json.dumps([fixture_key(h) for h in self.scan(next(iter(cases)))]))

    def test_new_detectors_ignore_prose_prefixes_and_ids(self):
        for text in ('"apiTokenSource": "env"', 'Basic auth is disabled', 'Basic <redacted>',
                     'docs_index ocs_', 'ghs_ gho_ ghu_ ghr_', 'eC1hY2Nlc3MtdG9rZW46',
                     'commit ' + 'a1' * 20, 'name ' + 'release-scan-negative-control-fixture-ab',
                     'integrity sha512-' + 'Ab1' * 30 + '=='):
            self.assertEqual(self.kinds(text) & {'secret_assignment', 'basic_auth', 'other_token', 'token', 'unprefixed_token'}, set(), text)

    def test_head_scan_fails_on_json_quoted_and_basic_credentials(self):
        body = 'Synth3ticValue' + 'Q' * 6
        with tempfile.TemporaryDirectory() as folder:
            old_cwd = pathlib.Path.cwd()
            try:
                os.chdir(folder)
                subprocess.check_call(['git', 'init', '-q'])
                pathlib.Path('config.json').write_text('{"api' + 'Token": "' + body + '"}\n')
                pathlib.Path('log.txt').write_text('Basic ' + base64.b64encode(('x-access-token:' + body).encode()).decode() + '\n')
                subprocess.check_call(['git', 'add', '.'])
                subprocess.check_call(['git', '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '-qm', 'fixture'])
                with contextlib.redirect_stdout(io.StringIO()) as printed:
                    self.assertEqual(main([]), 1)
                self.assertEqual(json.loads(printed.getvalue())['tree']['redact'], 2)  # quoted key + Basic header
                self.assertNotIn(body, printed.getvalue())
            finally:
                os.chdir(old_cwd)

    # Every credential format the product emits (README "Product credential formats"),
    # built at runtime in its real shape: base64url of 32 bytes, or the gateway's 64 hex.
    PRODUCT_CREDENTIALS = {
        'session': ('oc' + 's_', base64.urlsafe_b64encode(bytes(range(7, 39))).decode().rstrip('=')),
        'bootstrap': ('oc' + 'b_', base64.urlsafe_b64encode(bytes(range(40, 72))).decode().rstrip('=')),
        'approval grant': ('oc' + 'g_', base64.urlsafe_b64encode(bytes(range(80, 112))).decode().rstrip('=')),
        'gateway lease': ('oc' + 'g_', bytes(range(120, 152)).hex()),
        'submission grant': ('oc' + 'sg_', base64.urlsafe_b64encode(bytes(range(160, 192))).decode().rstrip('=')),
    }
    PREFIX_MENTIONS = ['`{p}` tokens', 'Bearer {p}…', "startsWith('{p}')", '`{p}${{random()}}`', 'the {p} prefix', '"{p}"']

    def in_temp_repo(self, files, *args):
        with tempfile.TemporaryDirectory() as folder, tempfile.TemporaryDirectory() as ledger:
            old_cwd = pathlib.Path.cwd()
            try:
                os.chdir(folder)
                subprocess.check_call(['git', 'init', '-q'])
                for name, text in files.items():
                    pathlib.Path(name).write_text(text)
                subprocess.check_call(['git', 'add', '.'])
                subprocess.check_call(['git', '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '-qm', 'fixture'])
                with contextlib.redirect_stdout(io.StringIO()) as printed:
                    code = main([*args, '--output', ledger])
                hits = json.loads((pathlib.Path(ledger) / 'head-or-history-hits.json').read_text())
                return code, json.loads(printed.getvalue()), hits, printed.getvalue()
            finally:
                os.chdir(old_cwd)

    def test_every_product_credential_format_fails_through_scan(self):
        files = {}
        for n, (label, (prefix, body)) in enumerate(self.PRODUCT_CREDENTIALS.items()):
            files[f'response-{n}.json'] = json.dumps({'id': 'grant-1', 'token': prefix + body, 'kind': label}) + '\n'
            files[f'log-{n}.txt'] = f'issued {label} {prefix}{body} to agent\n'
        code, summary, hits, printed = self.in_temp_repo(files)
        self.assertEqual(code, 1)
        for name in files:
            found = [h for h in hits if h['file'] == name and h['kind'] == 'other_token']
            self.assertEqual([h['disposition'] for h in found], ['redact'], name)
        self.assertEqual(summary['tree']['redact'], len(files))
        for _, body in self.PRODUCT_CREDENTIALS.values():
            self.assertNotIn(body, printed)

    def test_product_prefix_mentions_stay_fine_through_scan(self):
        prefixes = sorted({prefix for prefix, _ in self.PRODUCT_CREDENTIALS.values()})
        docs = '\n'.join(m.format(p=p) for p in prefixes for m in self.PREFIX_MENTIONS) + '\n'
        code, summary, hits, _ = self.in_temp_repo({'AUTH.md': docs, 'auth.ts': docs}, '--worktree')
        self.assertEqual(code, 0)
        self.assertEqual(summary['tree']['redact'], 0)
        self.assertFalse(any(h['kind'] == 'other_token' for h in hits))
        self.assertFalse(any(h['disposition'] != 'fine' for h in hits))

    def test_product_credentials_need_exact_fixture_review(self):
        for prefix, body in self.PRODUCT_CREDENTIALS.values():
            text = 'Bearer ' + prefix + body
            hit = next(h for h in self.scan(text) if h['kind'] == 'other_token')
            self.assertEqual(hit['disposition'], 'redact')
            other = lambda found: next(h for h in found if h['kind'] == 'other_token')['disposition']
            self.assertEqual(other(self.scan(text, fixtures={fixture_key(hit)})), 'allowlisted')
            self.assertEqual(other(self.scan(text + ' ', fixtures={fixture_key(hit)})), 'redact')
            self.assertEqual(other(self.scan(text, path='other.txt', fixtures={fixture_key(hit)})), 'redact')
            self.assertEqual(other(self.scan('Bearer ' + prefix + body[::-1], fixtures={fixture_key(hit)})), 'redact')

    def test_binary_skip_is_explicit(self):
        self.assertEqual(scan_text('data.bin', b'\0anything', PATTERNS, set()), ([], True))


if __name__ == '__main__':
    unittest.main()
