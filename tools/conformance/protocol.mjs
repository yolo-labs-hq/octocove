import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verdictOf } from './events/contract.mjs';
import { eventReport } from './event-oracles.mjs';
export const manifestBytes = readFileSync(new URL('./manifest.json', import.meta.url));
export const manifest = JSON.parse(manifestBytes);
export const manifestSha256 = createHash('sha256').update(manifestBytes).digest('hex');
export const statuses = new Set(['PASS', 'FAIL', 'INCOMPLETE', 'BLOCKED', 'NOT RUN']);
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
// Where cell results may be written and read: the scratch `.conformance/` in the repository, and `conformance/`
// under the evidence directory (OCTOCOVE_EVIDENCE_DIR, relative to the repository root or absolute, inside the
// repository or outside it; else the gitignored `.evidence/`). Absolute paths.
export function resultDirs(root = repoRoot) {
  return [resolve(root, '.conformance'), resolve(root, process.env.OCTOCOVE_EVIDENCE_DIR || '.evidence', 'conformance')];
}
// A result file (relative to the repository root, or absolute) as an absolute path, or null unless it is a `.json`
// file strictly inside one of the result directories; `..` segments resolve first, so they cannot leave them.
export function resultPath(file, root = repoRoot) {
  const path = resolve(root, file);
  const inside = dir => { const rel = relative(dir, path); return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };
  return path.endsWith('.json') && resultDirs(root).some(inside) ? path : null;
}
// Each archetype's driver is pinned in drivers/registration.json (`pinnedDriver`): (a) an external adapter
// repository and commit, checked out at the path its `pathEnv` variable names; (b) the CLI package version and the
// sha256 of the bundled CLI file; (c) the sha256 of drivers/machine.mjs. A cell whose driver is unpinned, or whose
// computed digest differs from the registration, is BLOCKED and never PASS.
export const registration = JSON.parse(readFileSync(new URL('./drivers/registration.json', import.meta.url)));
const sha256Hex = /^[a-f0-9]{64}$/, commitHex = /^[a-f0-9]{40}$/;
const pinFields = { a: ['commit'], b: ['cliVersion', 'bundleSha256'], c: ['sha256'] };
const fileSha256 = path => { try { return createHash('sha256').update(readFileSync(path)).digest('hex'); } catch { return null; } };
// The registered pin, or the reason it is not a usable pin.
function expectedPin(archetype, reg) {
  const pin = reg?.[archetype]?.pinnedDriver;
  if (!pinFields[archetype] || !pin) return { reason: `driver-unpinned:${archetype}:no-registered-driver` };
  const valid = archetype === 'a' ? /^https:\/\/\S+$/.test(pin.repository ?? '') && commitHex.test(pin.commit ?? '') && /^[A-Z][A-Z0-9_]*$/.test(pin.pathEnv ?? '')
    : archetype === 'b' ? /^\d+\.\d+\.\d+\S*$/.test(pin.cliVersion ?? '') && sha256Hex.test(pin.bundleSha256 ?? '')
      : sha256Hex.test(pin.sha256 ?? '');
  return valid ? { expected: Object.fromEntries(pinFields[archetype].map(key => [key, pin[key]])), pin }
    : { reason: `driver-unpinned:${archetype}:${archetype === 'a' ? 'adapter-repository-or-commit-not-registered' : 'digest-not-registered'}`, pin };
}
// Compares a computed driver identity with the registration: { pinned, reason }.
export function pinCheck(archetype, actual, reg = registration) {
  const { expected, reason } = expectedPin(archetype, reg);
  if (!expected) return { pinned: false, reason };
  if (!actual || typeof actual !== 'object') return { pinned: false, reason: `driver-unpinned:${archetype}:no-computed-digest` };
  if (actual.unavailable) return { pinned: false, reason: `driver-unpinned:${archetype}:${actual.unavailable}` };
  const field = pinFields[archetype].find(key => actual[key] !== expected[key]);
  return field ? { pinned: false, reason: `driver-digest-mismatch:${archetype}:${field}` } : { pinned: true, reason: null };
}
// Computes the driver identity this run uses. `cliBinary` is the bundled CLI file the host runs (archetype b).
export function computeDriver(archetype, { env = process.env, cliBinary, root = repoRoot, reg = registration } = {}) {
  const pin = reg?.[archetype]?.pinnedDriver ?? {};
  if (archetype === 'a') {
    const dir = pin.pathEnv && env[pin.pathEnv];
    if (!dir) return { unavailable: `adapter-path-unset:${pin.pathEnv ?? 'no-path-variable'}` };
    try {
      const git = (...args) => execFileSync('git', ['-C', resolve(root, dir), ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      const commit = git('rev-parse', 'HEAD');
      return git('status', '--porcelain') ? { unavailable: 'adapter-checkout-modified', commit } : { commit };
    } catch { return { unavailable: 'adapter-checkout-unreadable' }; }
  }
  if (archetype === 'b') {
    const bundleSha256 = fileSha256(cliBinary ? resolve(root, cliBinary) : resolve(root, pin.bundle ?? 'packages/cli/dist/octocove.mjs'));
    let cliVersion = null;
    try { cliVersion = JSON.parse(readFileSync(resolve(root, pin.package ?? 'packages/cli/package.json'), 'utf8')).version ?? null; } catch {}
    return bundleSha256 ? { cliVersion, bundleSha256 } : { unavailable: 'cli-bundle-missing', cliVersion };
  }
  if (archetype === 'c') {
    const sha256 = fileSha256(resolve(root, pin.file ?? 'tools/conformance/drivers/machine.mjs'));
    return sha256 ? { sha256 } : { unavailable: 'machine-driver-missing' };
  }
  return { unavailable: 'unknown-archetype' };
}
// The pin a run records: what the registration expects, what was computed, and the check.
export function driverPin(archetype, options = {}) {
  const reg = options.reg ?? registration, actual = computeDriver(archetype, { ...options, reg });
  return { archetype, expected: expectedPin(archetype, reg).expected ?? null, actual, ...pinCheck(archetype, actual, reg) };
}
// A pairing the manifest marks unsupported by design is never selected for qualification.
export const unsupportedByDesign = cell => manifest.unsupportedByDesign?.[`${cell?.provider}/${cell?.topology}`] ?? null;
// Why a cell cannot qualify (BLOCKED), or null. The recorded `actual` is re-checked against the registration,
// so a recorded `pinned: true` alone proves nothing.
export function driverBlock(cell, pin, reg = registration) {
  const design = unsupportedByDesign(cell);
  if (design) return design.reason ?? 'unsupported-by-design';
  if (!pin) return `driver-unpinned:${cell?.archetype}:pin-not-recorded`;
  if (pin.archetype !== cell?.archetype) return `driver-unpinned:${cell?.archetype}:pin-for-other-archetype`;
  return pinCheck(cell.archetype, pin.actual, reg).reason;
}
export function cells() {
  return manifest.matrix.archetypes.flatMap(archetype => manifest.matrix.providers.flatMap(provider =>
    manifest.matrix.topologies.flatMap(topology => manifest.matrix.targets.map(target =>
      ({ id: `${archetype}/${provider}/${topology}/${target.split('/').at(-1)}`, archetype, provider, topology, target })))));
}
export const keyOf = (cell, scenario, repetition) => `${cell.id}:${scenario.id}:${repetition}`;
export function blocked(cell, scenario, reason, status = 'BLOCKED') {
  return Array.from({ length: manifest.repetitions }, (_, i) => ({ protocol: manifest.protocol,
    key: keyOf(cell, scenario, i + 1), cell, scenario: scenario.id, repetition: i + 1, status, reason,
    assertions: [], evidence: null }));
}
export function check(name, value, details = null) {
  return { name, status: value === true ? 'PASS' : 'FAIL', details };
}
export function verdict(results, mode = 'local', selectedCells = cells(), repetitions = manifest.repetitions, startRepetition = 1) {
  const errors = [], expected = new Set(), seen = new Set(), expectedCells = new Map(selectedCells.map(cell => [cell.id,cell]));
  for (const cell of selectedCells) for (const scenario of manifest.scenarios)
    for (let rep = startRepetition; rep < startRepetition + repetitions; rep++) expected.add(keyOf(cell, scenario, rep));
  for (const r of results) {
    if (!expected.has(r.key) || seen.has(r.key)) errors.push(`unexpected-or-duplicate:${r.key}`);
    seen.add(r.key);
    const registeredCell = expectedCells.get(r.cell?.id);
    if (!registeredCell || Object.keys(registeredCell).some(key => r.cell?.[key] !== registeredCell[key])) errors.push(`invalid-cell:${r.key}`);
    if (r.protocol !== manifest.protocol || r.key !== keyOf(r.cell ?? {}, {id:r.scenario}, r.repetition)) errors.push(`invalid-envelope:${r.key}`);
    if (r.status === 'PASS' && (!manifest.localPairings.includes(`${r.cell?.provider}/${r.cell?.topology}`) || manifest.scenarios.find(s => s.id === r.scenario)?.local === 'blocked')) errors.push(`unsupported-pass:${r.key}`);
    if (!statuses.has(r.status)) errors.push(`invalid-status:${r.key}`);
    const scenario = manifest.scenarios.find(s => s.id === r.scenario);
    if (r.status === 'PASS') {
      if (!r.assertions?.length || r.assertions.some(a => a.status !== 'PASS')) errors.push(`unproven-pass:${r.key}`);
      const machineAssertions = r.cell?.archetype === 'c' && r.scenario === 'approval-denials' ? manifest.machineApprovalAssertions : [];
      for (const name of [...(scenario?.assertions ?? []),...machineAssertions])
        if (!r.assertions?.some(a => a.name === name && a.status === 'PASS')) errors.push(`missing-assertion:${r.key}:${name}`);
      if (!r.evidence || !r.driver?.version) errors.push(`missing-provenance:${r.key}`);
      if (r.evidence?.cleanup?.confirmed !== true) errors.push(`unconfirmed-cleanup:${r.key}`);
      if (r.cell?.archetype === 'c' && r.scenario === 'journey' && r.driver?.kind !== 'actual-headless-octocove-bin') errors.push(`unregistered-machine-driver:${r.key}`);
      if (r.scenario === 'journey' && r.driver?.developmentDouble) errors.push(`fake-driver-journey:${r.key}`);
      if (mode === 'live' && r.cell?.archetype === 'a' && r.scenario === 'journey' && !/^[a-f0-9]{40}$/.test(r.driver?.revision ?? '')) errors.push(`unpinned-adapter:${r.key}`);
      if (mode === 'live' && r.evidence?.providerDouble !== false) errors.push(`double-in-live:${r.key}`);
      if (r.scenario === 'exact-record') {
        const e = r.evidence, receipt = e?.receipt, remote = e?.remoteVerification;
        if (!/^[a-f0-9]{40}$/.test(e?.candidateSha ?? '') || receipt?.outcome !== 'landed' || receipt?.candidateSha !== e?.candidateSha ||
            receipt?.landedSha !== remote?.fetchedSha || remote?.fetchedSha !== e?.candidateSha || remote?.parentSha !== e?.baseSha ||
            receipt?.baseShaBefore !== e?.baseSha || receipt?.intentVersion !== e?.intentVersion || receipt?.targetRef !== r.cell.target ||
            receipt?.repositoryId !== e?.repositoryId || receipt?.approvalId !== e?.approvalId || !remote?.verified ||
            !Number.isFinite(e?.timings?.reconciliationMs) || e.timings.reconciliationMs > manifest.thresholds.reconciliationMs)
          errors.push(`invalid-remote-receipt:${r.key}`);
      }
    }
  }
  for (const key of expected) if (!seen.has(key)) errors.push(`missing:${key}`);
  const counts = Object.fromEntries([...statuses].map(s => [s, results.filter(r => r.status === s).length]));
  const pass = !errors.length && counts.PASS === expected.size;
  const concreteError = errors.some(error => !error.startsWith('missing:'));
  const incomplete = counts.INCOMPLETE || counts['NOT RUN'] || errors.some(error => error.startsWith('missing:'));
  return { status: pass ? 'PASS' : concreteError || counts.FAIL ? 'FAIL' : incomplete ? 'INCOMPLETE' : 'BLOCKED', qualified: pass, counts, errors, requiredResults: expected.size };
}
export function sanitize(value, key = '') {
  if (/account/i.test(key) || (/token|secret|password|credential|authorization|cookie|privateKey|plaintext/i.test(key) && typeof value !== 'number' && typeof value !== 'boolean')) return '<redacted>';
  if (Array.isArray(value)) return value.map(v => sanitize(v, key));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k,sanitize(v,k)]));
  if (typeof value === 'string') {
    if (key === 'id' && (manifest.scenarios.some(s => s.id === value) || cells().some(c => c.id === value))) return value;
    if (/^(?:id|.*Id|.*Ids|actor|subject|sub|issuer)$/i.test(key)) return `id_${createHash('sha256').update(value).digest('hex')}`;
    if (/Bearer\s|(?:cfut_|art_v1_|ocs_|ocd_|ocb_)[A-Za-z0-9_-]+|https?:\/\/[^\s]*[?@]|(?:\/home\/|\/tmp\/|\/workspace\/|\/Users\/|[A-Z]:\\)/i.test(value)) return '<redacted>';
    return value.slice(0, 256);
  }
  return value;
}

export function summarizeRows(rows, selectedCells, repetitions = manifest.repetitions, startRepetition = 1, qualificationRepetitions = repetitions) {
  return selectedCells.map(cell => {
    const present = rows.filter(r => r.cell?.id === cell.id);
    const indexed = new Map(present.map(r => [r.key, r]));
    const complete = manifest.scenarios.flatMap(scenario => Array.from({length:repetitions}, (_, i) => {
      const unsupported = !manifest.localPairings.includes(`${cell.provider}/${cell.topology}`) || scenario.local === 'blocked';
      return indexed.get(keyOf(cell, scenario, i + startRepetition)) ?? { protocol:manifest.protocol,
        key:keyOf(cell, scenario, i + startRepetition), cell, scenario:scenario.id, repetition:i+startRepetition,
        status:unsupported ? 'BLOCKED' : 'NOT RUN', reason:unsupported ? scenario.reason ?? 'unsupported-local-pairing' : 'required-evidence-missing' };
    }));
    const oracle = verdict([...present, ...complete.filter(r => !indexed.has(r.key))], 'local', [cell], repetitions, startRepetition);
    const scenarios = manifest.scenarios.map(s => {
      const rs = complete.filter(r => r.scenario === s.id);
      return { id:s.id, verdict:rs.some(r => r.status === 'FAIL') ? 'FAIL' : rs.some(r => ['NOT RUN','INCOMPLETE'].includes(r.status)) ? 'INCOMPLETE' : verdictOf(rs.map(r => r.status)),
        counts:Object.fromEntries([...statuses].map(status => [status,rs.filter(r => r.status === status).length])),
        reasons:[...new Set(rs.map(r => r.reason).filter(Boolean))].slice(0,5),
        failedAssertions:[...new Set(rs.flatMap(r => (r.assertions ?? []).filter(a => a.status !== 'PASS').map(a => a.name)))].slice(0,20) };
    });
    const exact = present.filter(r => r.scenario === 'exact-record' && r.status === 'PASS');
    const samples = present.filter(r => r.scenario === 'exact-record').map(r => r.evidence?.timings?.adapterOnlyMs).filter(Number.isFinite);
    const remoteReceipts = exact.filter(r => r.evidence?.remoteVerification?.verified === true).length;
    const p95 = percentile(samples,0.95);
    const timingErrors = exact.length === qualificationRepetitions && (samples.length !== repetitions || p95 > manifest.thresholds.adapterOnlyP95Ms || remoteReceipts !== repetitions)
      ? ['incomplete-receipts-or-adapter-timing'] : [];
    const errors = [...oracle.errors, ...timingErrors];
    const completedRepetitions = Array.from({length:repetitions},(_,i) => i+startRepetition).filter(r => present.some(row => row.repetition === r && row.completed === true)).length;
    return { ...cell, completedRepetitions, lastCompletedRepetition:completedRepetitions ? startRepetition+completedRepetitions-1 : startRepetition-1, requiredRepetitions:repetitions,
      verdict:errors.length || oracle.counts.FAIL || present.some(r => r.assertions?.some(a => a.status === 'FAIL')) ? 'FAIL' : scenarios.some(s => s.verdict === 'INCOMPLETE') ? 'INCOMPLETE' : verdictOf(scenarios.map(s => s.verdict)),
      counts:oracle.counts, requiredResults:oracle.requiredResults, errors:errors.slice(0,20), errorCount:errors.length, scenarios,
      ...(cell.archetype === 'c' ? {machineEvidence:exact.filter(r => r.evidence?.machine).slice(0,manifest.rawTimingCap).map(r => ({
        repetition:r.repetition,...r.evidence.machine,candidateSha:r.evidence.candidateSha,baseSha:r.evidence.baseSha,
        intentVersion:r.evidence.intentVersion,repositoryId:r.evidence.repositoryId,approvalId:r.evidence.approvalId,
        receipt:r.evidence.receipt,remoteVerification:r.evidence.remoteVerification
      }))} : {}),
      remoteReceipts, timings:{ adapterOnlyP95Ms:p95, sampleCount:samples.length || null, rawSamples:samples.slice(0,manifest.rawTimingCap) },
      repetitions:present.length ? Array.from({length:repetitions}, (_,i) => {
        const rs = present.filter(r => r.repetition === i+startRepetition);
        return {repetition:i+startRepetition,completed:rs.some(r => r.completed === true),reason:rs.find(r => r.reason)?.reason ?? null,
          cleanupFailure:rs.find(r => r.cleanupFailure)?.cleanupFailure ?? null,
          cleanupConfirmed:rs.length ? rs.every(r => r.evidence?.cleanup?.confirmed === true) : null,
          failedAssertions:[...new Set(rs.flatMap(r => (r.assertions ?? []).filter(a => a.status === 'FAIL').map(a => `${r.scenario}:${a.name}`)))].slice(0,20),
          stderr:rs.find(r => r.stderr?.length)?.stderr ?? [],
          timings:rs.find(r => r.evidence?.timings)?.evidence.timings ?? null, cellMs:rs.find(r => Number.isFinite(r.evidence?.cellMs))?.evidence.cellMs ?? null};
      }) : [],
      events:eventReport(cell), qualification:'local-fixtures-only' };
  });
}
/** Cells in one shard share a fixture whose observations (e.g. the provider-double
 * issuance count) are environment-wide. Vitest does not cancel a timed-out test body,
 * so a later cell waits for the earlier loop to settle, and an aborted signal stops a
 * loop at its next repetition boundary. Unstarted repetitions stay NOT RUN. */
export function serialCells() {
  let tail = Promise.resolve(), active = 0;
  return {
    get active() { return active; },
    run(signal, repetitions, repetition, startRepetition = 1) {
      const loop = tail.then(async () => {
        active++;
        try { for (let r = startRepetition; r <= repetitions && !signal?.aborted; r++) await repetition(r); }
        finally { active--; }
      });
      tail = loop.catch(() => {});
      return loop;
    },
    async settle(ms) {
      let timer;
      try { return await Promise.race([tail.then(() => true), new Promise(resolve => { timer = setTimeout(resolve, ms, false); })]); }
      finally { clearTimeout(timer); }
    },
  };
}
export function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.ceil(sorted.length * p) - 1] : null;
}
