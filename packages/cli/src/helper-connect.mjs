#!/usr/bin/env node
import { runConnector } from '../../helper/src/connect.mjs';
import { agentSessionFetch } from './session.js';
import { activeCredentials } from './config.js';
import { getConfig, systemGit } from './git.js';
import { startManagedHelper, requireAgentCredential } from './managed-helper.mjs';

let managed;
const controller = new AbortController();
let interrupted = 0;
const interrupt = signal => { interrupted = signal === 'SIGINT' ? 130 : 143; controller.abort(); };
process.on('SIGINT', interrupt);process.on('SIGTERM', interrupt);
const parent = process.ppid;
const supervision = setInterval(() => { if(process.ppid !== parent) controller.abort(); },250);
supervision.unref();
try {
  let socketPath = process.env.OCTOCOVE_HELPER_SOCK;
  if (!socketPath) {
    const credential = await activeCredentials(process.env);
    requireAgentCredential(credential?.kind);
    const git = systemGit(process.cwd());
    const [taskId,claimId,projectId,baseSha] = await Promise.all(['taskId','claimId','projectId','baseSha'].map(key=>getConfig(git,`octocove.${key}`)));
    if (!taskId || !claimId || !projectId) throw new Error('claim first to bind this repository to the agent');
    managed = await startManagedHelper({...credential,taskId,claimId,projectId,baseSha,
      fetch:agentSessionFetch(process.env,credential,(url,init)=>fetch(url,init)),signal:controller.signal,stderr:text=>process.stderr.write(text)});
    socketPath=managed.socketPath;
  }
  const code = await new Promise(resolve=>runConnector({service:process.argv[2],socketPath,gitProtocol:process.env.GIT_PROTOCOL??'',
    stdin:process.stdin,stdout:process.stdout,onExit:resolve,signal:controller.signal}));
  process.exitCode=interrupted || (managed?.failure ? 1 : code);
} catch(error) {process.stderr.write((error.message?.startsWith('helper:') ? error.message : 'helper: agent transport unavailable; use this agent\'s config directory and claim bootstrap')+'\n');process.exitCode=interrupted||1;}
finally {clearInterval(supervision);await managed?.close();process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',interrupt);}
