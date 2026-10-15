#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { activeCredentials } from './config.js';
import { humanSessionFetch } from './session.js';
import { Api, baseUrlOf } from './http.js';
import { checkBaseUrl } from '../../client/src/client.js';

/** A Git credential-pipe endpoint, never a CLI output or provider token exchange. */
export async function humanCredential({ argv, stdin, stdout, stderr, fetch, env, signal }) {
  try {
    const { values, positionals } = parseArgs({ args:argv, options:{ 'config-dir':{type:'string'},url:{type:'string'} }, allowPositionals:true, strict:true });
    if(positionals.length!==1 || !['get','store','erase'].includes(positionals[0]))throw new Error();
    let input='';for await(const chunk of stdin){input+=chunk.toString();if(input.length>16384)throw new Error();}
    // Git sends credentials back after authentication. Never store, log or broker them.
    if(positionals[0]!=='get')return 0;
    if(!values['config-dir'] || !values.url)throw new Error();
    const remote=new URL(values.url);
    checkBaseUrl(remote.origin);
    if(remote.username || remote.password || remote.search || remote.hash || !/^\/v1\/projects\/[^/]+\/repositories\/[^/]+\/git$/.test(remote.pathname))throw new Error();
    const fields=Object.fromEntries(input.split('\n').filter(Boolean).map(line=>{const at=line.indexOf('=');if(at<1)throw new Error();return [line.slice(0,at),line.slice(at+1)];}));
    if(fields.protocol!==remote.protocol.slice(0,-1) || fields.host!==remote.host || fields.path!==remote.pathname.slice(1) || (fields.username && fields.username!=='octocove'))return 0;
    const selected={...env,OCTOCOVE_CONFIG_DIR:resolve(values['config-dir'])};
    delete selected.OCTOCOVE_BOOTSTRAP_FILE;
    const credential=await activeCredentials(selected);
    if(!credential || credential.kind!=='human' || checkBaseUrl(baseUrlOf(credential.apiUrl))!==remote.origin)throw new Error();
    const api=new Api({apiUrl:credential.apiUrl,credential,fetch:humanSessionFetch(selected,credential,fetch),signal});
    const me=await api.j.auth.me(api.until(Date.now()+30000));
    if(me.principal.kind!=='human')throw new Error();
    const current=await activeCredentials(selected);
    if(!current || current.kind!=='human' || current.apiUrl!==credential.apiUrl || /[\r\n\0]/.test(current.token))throw new Error();
    stdout([['username','octocove'],['password',current.token]].map(([key,value])=>`${key}=${value}`).join('\n')+'\n\n');
    return 0;
  } catch {
    stdout('quit=true\n\n');
    stderr('octocove: human Git credential unavailable; sign in with octocove login using the selected config directory. Agent credentials cannot be used for human clones.\n');
    return 1;
  }
}
