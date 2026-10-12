// Shared fixed adversarial corpus: 25 variants cycled to 1,000 cases with varying stream
// boundaries and gzip. Used unchanged by the lease-only and proof-mode gateway runs.
import { concat, pkt } from '../src/protocol.mjs';
export const z = '0'.repeat(40), a = 'a'.repeat(40), b = 'b'.repeat(40), enc = new TextEncoder();
export const pack = concat([enc.encode('PACK'), new Uint8Array([0,0,0,2,0,0,0,0]), new Uint8Array(20)]);
export const command = (ref, old = a, next = b, caps = 'report-status side-band-64k') => pkt(`${old} ${next} ${ref}${caps === null ? '' : '\0'+caps}\n`);
export const body = (...commands) => concat([...commands, enc.encode('0000'), pack]);
export const variants = [
  ['main',()=>body(command('refs/heads/main'))], ['sibling',()=>body(command('refs/heads/lane/beta'))],
  ['integration',()=>body(command('refs/heads/staging/integration'))], ['receipt',()=>body(command('refs/octocove/receipts/r'))],
  ['mixed',()=>body(command('refs/heads/lane/alpha'),command('refs/heads/main',a,b,null))],
  ['delete-main',()=>concat([command('refs/heads/main',a,z),enc.encode('0000')])],
  ['percent-ref',()=>body(command('refs/heads/lane/%61lpha'))], ['unicode-ref',()=>body(command('refs/heads/lane/аlpha'))],
  ['dotdot',()=>body(command('refs/heads/lane/alpha/../main'))], ['double-nul',()=>body(pkt(`${a} ${b} refs/heads/lane/alpha\0report-status\0x`))],
  ['short-length',()=>concat([enc.encode('0003'),pack])], ['bad-hex',()=>enc.encode('00xzhello0000')],
  ['truncated',()=>enc.encode('ffffshort')], ['missing-flush',()=>command('refs/heads/lane/alpha')],
  ['late-nul',()=>body(command('refs/heads/lane/alpha'),command('refs/heads/main'))],
  ['newline-in-ref',()=>body(command('refs/heads/lane/alpha\nrefs/heads/main'))],
  ['push-options',()=>body(command('refs/heads/lane/alpha',a,b,'report-status push-options'))],
  ['push-cert',()=>body(pkt('push-cert\0report-status\n'))], ['duplicate',()=>body(command('refs/heads/lane/alpha'),command('refs/heads/lane/alpha',a,b,null))],
  ['invalid-utf8',()=>concat([pkt(concat([enc.encode(`${a} ${b} refs/heads/lane/`),new Uint8Array([255])])),enc.encode('0000'),pack])],
  ['owned-create',()=>body(command('refs/heads/lane/alpha',z,b)),true],
  ['owned-update',()=>body(command('refs/heads/lane/alpha')),true],
  ['owned-delete',()=>concat([command('refs/heads/lane/alpha',a,z),enc.encode('0000')]),true],
  ['owned-no-nul',()=>body(command('refs/heads/lane/alpha',a,b,null)),true],
  ['pack-after-delete',()=>body(command('refs/heads/lane/alpha',a,z))],
];
