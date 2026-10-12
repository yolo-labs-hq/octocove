"""Disposition policy: remove, redact, allowlisted or fine for each scan candidate.

Reviewed synthetic fixtures and credential plumbing are accepted by exact
path/kind/match/line digests in fixture-allowlist.json, never by path globs.

Detectors are patterns.json (generic, published) merged with
extra-patterns.json (a maintainer's own system names and hosts, kept outside
this repository) when that file is present. Without it the same policy runs over the generic detectors.
"""
import hashlib
import json
import pathlib
import re

HERE = pathlib.Path(__file__).resolve().parent
DEFINITIONS = ('tools/release-scan/patterns.json', 'tools/release-scan/extra-patterns.json')


def private_rules(folder=HERE):
    """The optional maintainer rule file, or {} where it is absent."""
    path = pathlib.Path(folder) / 'extra-patterns.json'
    return json.loads(path.read_text()) if path.is_file() else {}


def detector_sources(folder=HERE):
    """Kind -> expression text: the generic detectors, then any private ones."""
    public = json.loads((pathlib.Path(folder) / 'patterns.json').read_text())
    private = private_rules(folder).get('detectors', {})
    if public.keys() & private.keys():
        raise ValueError(f'detector kinds defined twice: {sorted(public.keys() & private.keys())}')
    return {**public, **private}


def load_patterns(folder=HERE):
    return {kind: re.compile(value) for kind, value in detector_sources(folder).items()}


OPERATOR_HOSTS = private_rules().get('operator_hosts', {})


def digest(text):
    return hashlib.sha256(text.encode()).hexdigest()


def fixture_key(hit):
    return (hit['file'], hit['kind'], digest(hit['value']), digest(hit['context']))


def disposition(hit, fixtures=frozenset(), historical=False):
    kind, value, context = hit['kind'], hit['value'], hit['context']
    path = hit['file']
    # Definitions are scanned, but matching a detector's own expression isn't
    # an operational identifier. No other scanner files get a blanket exemption.
    if path in DEFINITIONS:
        return 'fine', 'Detector definition.'
    if fixture_key(hit) in fixtures:
        return 'allowlisted', 'Exact reviewed synthetic fixture or credential plumbing.'
    if kind in ('sandbox', 'account_hint', 'org_domain', 'private_repo'):
        if kind == 'private_repo' and value.rsplit('/', 1)[-1].rstrip('.') in ('octocove', 'octocove.git', 'git-credential-artifacts', 'octocove-maintainers'):
            return 'fine', 'Public product/helper repository or team reference.'
        return 'redact', 'Operator identity or private source location.'
    if kind in ('cftokens', 'infra'):
        return 'remove', 'Operator-specific setup or private deployment assumption.'
    if kind == 'token' and value in ('cfut_', 'art_v1_', 'ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_', 'github_pat_'):
        return 'fine', 'Bare token prefix or detector, no credential bytes.'
    # base64('x-access-token:') alone is a detector literal; any encoded credential bytes follow it.
    if kind == 'basic_auth' and value == 'eC1hY2Nlc3MtdG9rZW46':
        return 'fine', 'Bare encoded-credential prefix or detector, no credential bytes.'
    if kind in ('token', 'jwt', 'private_key', 'other_token', 'secret_assignment', 'hex32', 'basic_auth', 'unprefixed_token'):
        return 'redact', 'Unreviewed credential, assignment or account-sized identifier.'
    if kind == 'account_literal':
        # Account routes and configuration variable names are public API syntax.
        if re.search(r'\b[a-fA-F0-9]{32}\b', value):
            return 'redact', 'Concrete account identity.'
        if any(marker in value for marker in ('<', ':id', '${', 'env.', 'this.', 'local', 'test', 'fake', 'redacted')):
            return 'fine', 'Variable, placeholder or synthetic account.'
        return 'redact', 'Unreviewed account literal.'
    if kind == 'email':
        if value.endswith(('.invalid', '.example', '@example.com', '@example.org', '@users.noreply.github.com', '@noreply.github.com', '@noreply.anthropic.com')):
            return 'fine', 'Synthetic address or public noreply attribution.'
        return 'redact', 'Unapproved contact or contributor identity.'
    if kind in ('host', 'url_host'):
        if value.endswith(tuple(OPERATOR_HOSTS.get('suffixes', ()))) or value in OPERATOR_HOSTS.get('exact', ()):
            return 'redact', 'Operator-specific host.'
        return 'fine', 'Reference/example host or local binding label.'
    if kind == 'private_names':
        if value.lower() == 'proprietary':
            if historical or 'supersedes' in context.lower():
                return 'fine', 'Explicitly superseded historical licensing decision.'
            return 'remove', 'Current licensing assertion conflicts with release decision.'
        return 'fine', 'Attribution, external adapter relationship or generic provider.'
    return 'fine', 'Reviewed public scan candidate.'
