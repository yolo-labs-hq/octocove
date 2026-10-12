// Explicit local provider transport double for the actual CLI subprocess.
// Registration/remote/config queries stay real; only registered network Git
// destinations become local bare paths before exec of the native Git binary.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2), binary = '/usr/bin/git';
// The CLI's git runs with an allowlisted environment, so the registries are also found next to
// the installed shim (<dir>/git-bin/git → <dir>/git-{remotes,helpers}.json).
const registry = (variable, name) => process.env[variable] || join(dirname(process.argv[1]), '..', name);
if (['push','fetch','ls-remote'].includes(args[0])) {
  const index = args.findIndex((arg,i) => i > 0 && !arg.startsWith('-'));
  const configured = args[index];
  let resolved = /^https:\/\//.test(configured ?? '') ? configured :
    spawnSync(binary,['remote','get-url',configured ?? ''],{encoding:'utf8'}).stdout?.trim();
  if (resolved === 'ext::octocove-helper-connect %s') {
    // Model the protected runtime's server-derived endpoint, without qualifying
    // production helper transport or isolation. CLI URL/config checks stay real.
    const route = JSON.parse(readFileSync(registry('CONFORMANCE_GIT_HELPERS','git-helpers.json'),'utf8'))[process.env.OCTOCOVE_HELPER_SOCK];
    if (!route || (args[0] === 'push' && (args.length !== index+2 ||
        !/^[a-f0-9]{40}:/.test(args[index+1]) || args[index+1].split(':')[1] !== route.ref))) {
      process.stderr.write('conformance-unregistered-helper-transport\n'); process.exit(128);
    }
    resolved = route.remote;
  }
  const local = JSON.parse(readFileSync(registry('CONFORMANCE_GIT_REMOTES','git-remotes.json'),'utf8'))[resolved];
  if (!local) { process.stderr.write('conformance-unregistered-git-transport\n'); process.exit(128); }
  args[index] = local;
}
const child = spawnSync(binary,args,{stdio:'inherit',env:process.env});
process.exit(child.status ?? 1);
