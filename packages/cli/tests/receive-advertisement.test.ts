import { expect, it } from 'vitest';
import { receiveAdvertisement } from '../src/receive-advertisement.mjs';
const ref='refs/octocove/claims/C1', zero='0'.repeat(40), tip='a'.repeat(40), base='b'.repeat(40);
const pkt=(line:string)=>(Buffer.byteLength(line)+4).toString(16).padStart(4,'0')+line;
const ad=(first:string,rest:string[]=[])=>Buffer.from(pkt('# service=git-receive-pack\n')+'0000'+pkt(first+'\0report-status ofs-delta object-format=sha1\n')+rest.map(line=>pkt(line+'\n')).join('')+'0000');
it('accepts the Worker fresh capabilities marker and base/head haves, strips the HTTP preamble and empty-ref hints',()=>{
  const result=receiveAdvertisement(ad(`${zero} capabilities^{}`,[`${base} .have`,`${tip} .have`]),ref);
  expect(result.oldSha).toBe(zero);
  expect(result.bytes.toString()).toBe(pkt(`${zero} capabilities^{}\0report-status ofs-delta object-format=sha1\n`)+'0000');
});
it('retains an existing exact claim tip and haves',()=>{
  const result=receiveAdvertisement(ad(`${tip} ${ref}`,[`${base} .have`]),ref);
  expect(result.oldSha).toBe(tip);expect(result.bytes.toString()).toContain(`${tip} ${ref}`);expect(result.bytes.toString()).toContain(`${base} .have`);
});
it.each([
  ad(`${tip} refs/octocove/claims/other`),ad(`${tip} refs/heads/main`),
  ad(`${zero} capabilities^{}`,[`${tip} refs/octocove/claims/other`]),
  ad(`${zero} capabilities^{}`,[`${zero} .have`]),ad(`${tip} capabilities^{}`),
  Buffer.from('zzzzbad'),Buffer.from(pkt(`${tip} ${ref}\0report-status\n`)),
  Buffer.concat([ad(`${tip} ${ref}`),Buffer.from('0000')]),
])('refuses malformed or foreign advertisements',bytes=>{expect(()=>receiveAdvertisement(bytes,ref)).toThrow('invalid claim advertisement');});
