/** Command-specific help is pure data: no config, Git, network or credential reads. */
const FLAGS: Record<string,string> = {
  acceptance: 'JSON array of strings, for example \'["Tests pass", "Help describes every flag"]\'. Quote the array as one shell argument.',
  task: 'Task ID; defaults to the current workspace task binding where supported.',
  title: 'Short human-readable task title.', description: 'Task intent and implementation context.',
  project: 'Project ID (or slug where accepted by the command).', repository: 'Canonical repository ID for the task or source.',
  'target-ref': 'Full canonical branch ref, for example refs/heads/main.', key: 'Unique task key within the project.',
  'change-note': 'Reason for editing the intent contract.', 'intent-version': 'Current positive intent version; rejects a stale contract.',
  'expected-status': 'Exact current task status required for this transition.', upstream: 'Upstream task ID whose landed receipt this task requires.',
  replacement: 'Task ID replacing this task.', claim: 'Exact claim ID; defaults to the workspace binding where supported.',
  'expires-at': 'Delegation/claim expiry as an absolute ISO 8601 timestamp, for example YYYY-MM-DDTHH:mm:ssZ; choose a future time within server policy.',
  agent: 'Opaque agent ID chosen by the delegating human: nonempty, at most 128 characters. No agent registration or human login is required for this label. Use a separate agent config directory and its own bootstrap; this does not change the signed-in human.',
  verbs: 'Comma-separated permission names. The human must hold every permission granted; no permissions are implied.',
  lane: 'Lane strategy: chain (default) or ref (classic per-task lane). --source-ref selects the existing external ref path unless --lane is explicit.',
  'chain-id': 'Stable chain ID (letters, digits, underscore or hyphen, at most 120 characters); defaults to predecessor chain or task ID.',
  base: 'Exact immutable base commit SHA; chain claims default to the predecessor receipt or known canonical head.',
  'previous-task': 'Previous landed task in the chain; its accepted receipt supplies the next base.',
  canonical: 'Credential-free canonical repository URL/path. Workspace cache commands support HTTPS, SSH, file and local paths.',
  'source-ref': 'Existing local branch to claim through a registered external repository; implies ref unless --lane is specified.',
  remote: 'Git remote name; defaults to octocove for allocated lanes or origin for --source-ref.',
  'bootstrap-file': 'Protected authorization hand-off file. Claim it within about 5 minutes of authorization; it is replaced by the scoped agent delegation.',
  wait: 'Bounded wait in seconds (claim and lane push default 60); land/receipt --wait is a boolean that waits for a receipt.',
  source: 'Exact source commit SHA for submission/push, or credential-free source clone URL/path for workspace commands.',
  'push-id': 'Stable push ID for recovering the same lane push.', submission: 'Submission ID whose candidate should be shown.',
  'candidate-sha': 'Exact candidate commit SHA being approved.', 'base-sha': 'Exact approved canonical base commit SHA.',
  note: 'Optional human approval note.', approval: 'Approval ID bound to this exact candidate and base.',
  after: 'Exclusive event/delivery cursor to start after.', through: 'Inclusive final event cursor to replay through.',
  from: 'Starting live-event cursor.', checkpoint: 'Local file for resumable event cursors.', follow: 'Follow the project event stream until interrupted.',
  limit: 'Maximum number of records in one page; server bounds apply.', cursor: 'Opaque continuation cursor from the previous page.',
  status: 'Filter by record status; permitted values appear in Usage.', name: 'Human-readable project/repository name.',
  principal: 'Existing principal ID to add to this project.', role: 'Member role: member (default) or approver.',
  namespace: 'Artifacts namespace for an existing canonical repository.', repo: 'Provider repository ID.', head: 'Exact known head SHA (workspace refresh uses the task head).',
  seed: 'Create an initial README commit; create mode only, default false.', import: 'Credential-free HTTPS source to import; cannot be combined with --seed.',
  branch: 'Branch to import from the source.', url: 'HTTPS webhook destination.', types: 'Comma-separated webhook event types.',
  'secret-stdin': 'Read the webhook signing secret from stdin; never place it in arguments.', delivery: 'Exact delivery ID to redrive.',
  'overlap-seconds': 'Seconds to accept the previous webhook secret during rotation.',
  as: 'Expected machine principal ID; never an actor override.', scope: 'Exact machine grant scope as one JSON object.',
  purpose: 'Machine grant purpose: submit or approve (default approve).', grant: 'Protected machine grant ID; activates the headless path.',
  'token-stdin': 'Read workload proof from stdin instead of OCTOCOVE_WORKLOAD_TOKEN.', timeout: 'Machine command deadline in seconds, 1–300 (default 30).',
  cache: 'Local workspace cache root; defaults to the user cache directory.', 'canonical-id': 'Stable cache identity, defaults to canonical locator.',
  ref: 'Canonical full branch ref (default refs/heads/main).', worktree: 'Local worktree ID; required for open/refresh/retire.',
  sparse: 'Comma-separated relative directories for sparse checkout.', count: 'Number of prepared worktrees, 1–16 (default 1).',
};
const POSITIONALS: Record<string,string> = {
  PROJECT:'Project slug or ID.', REPOSITORY:'Repository ID (clone also accepts a name; optional only when exactly one canonical exists).',
  DIR:'Destination directory; defaults to repository name. Must be absent or empty.', SLUG:'URL-safe project slug.',
  REF:'Local source ref; defaults to HEAD. Cannot be combined with --source.',
  CANDIDATE_ID:'Candidate ID to land (not a task ID).', DELEGATION_ID:'Delegation ID to revoke; defaults to the active delegation.',
};
const MINIMUM_VERBS = `Minimum agent workflow permissions (pass all seven explicitly):
  tasks:list          list project tasks
  tasks:read          read intent, canonical base and clone authority
  tasks:claim         claim the authorized task
  claims:read         inspect claim authority and provisioning
  submissions:create  submit the agent's work
  candidates:read     poll and inspect the computed candidate
  receipts:read       read landing receipts
Example: --verbs tasks:list,tasks:read,tasks:claim,claims:read,submissions:create,candidates:read,receipts:read

The bootstrap expires about 5 minutes after authorization. Use its file to claim promptly.
--expires-at controls the longer-lived delegation expiry, not the bootstrap window.
The human alone approves; do not grant approval authority to a worker.`;

export function commandHelp(command: string, originalUsage: string, description = '') {
  let usage = originalUsage;
  if (command === 'task claim' || command === 'claim') usage = `${command} ID [--lane chain|ref] [--chain-id ID] [--base SHA] [--previous-task ID] [--source-ref REF --repository ID] [--intent-version N] [--remote NAME] [--canonical URL] [--wait SECONDS] [--bootstrap-file FILE]`;
  if (command.startsWith('workspace ')) usage = `${command} --canonical URL [--canonical-id ID] [--ref REF] [--cache DIR] [--worktree ID] [--lane ID] [--base SHA] [--head SHA] [--source URL] [--sparse PATHS] [--count N]`;
  if (command === 'auth revoke') usage = 'auth revoke [DELEGATION_ID] [--grant ID --purpose submit|approve --timeout SECONDS]';
  if (command === 'auth exchange') usage += ' [--timeout SECONDS]';
  if (['approve','submit'].includes(command)) usage += ' [--grant ID --as ID --timeout SECONDS]';
  if (command === 'auth approve') usage = 'auth approve --grant ID [--as ID] [--timeout SECONDS]';
  if (command === 'auth revoke') description = 'Revoke a delegation (defaults to the active one); --grant revokes machine authority as a human administrator.';
  if (command === 'events') usage += ' [--limit N]';
  const optionMatches = [...usage.matchAll(/--([a-z][a-z-]*)(?: ([A-Z][A-Z_]*|[a-z]+(?:\|[a-z]+)+|a,b))?/g)];
  const options = [...new Map(optionMatches.map(m=>[m[1]!,m[0]])).entries()].map(([flag,label])=> {
    let detail = FLAGS[flag];
    if (flag === 'lane' && command.startsWith('workspace ')) detail = 'Deprecated alias for --worktree (local cache ID, not a lane strategy).';
    if (flag === 'wait' && ['land','receipt show'].includes(command)) detail = 'Wait for the final receipt (boolean flag, no value).';
    if (flag === 'wait' && command === 'login') detail = 'Browser-consent wait in seconds (default 600).';
    if (!detail) throw new Error(`missing option help: ${command} --${flag}`);
    return `  ${label.padEnd(28)} ${detail}`;
  });
  const positionalUsage=usage.slice(command.length).replace(/--[a-z-]+(?: [A-Z][A-Z_]*| [a-z]+(?:\|[a-z]+)+| a,b)?/g,'');
  const args=[...new Set(positionalUsage.match(/\b[A-Z][A-Z_]*\b/g)??[])].map(name=>`  ${name.padEnd(28)} ${POSITIONALS[name] ?? (command==='task claim-status'?'Claim ID (not a task ID).':command.startsWith('receipt ')?'Receipt ID.':command.startsWith('webhook ')?'Webhook subscription ID.':command.startsWith('project ')?'Project ID.':command==='approve'?'Candidate ID to approve.':'Task ID for this command.')}`);
  return `Usage: octocove ${usage}\n${description?`\n${description}\n`:''}${args.length?`\nArguments:\n${args.join('\n')}\n`:''}\nOptions:\n${options.join('\n') || '  This command has no command-specific flags.'}\n${command==='task authorize'?`\n${MINIMUM_VERBS}\n`:''}${['approve','submit'].includes(command)?'\nWith --grant, use only ID, --grant, --as, --timeout and global JSON/idempotency options. The protected grant supplies the exact target and source/approval fields.\n':''}${['task create','task edit'].includes(command)?`\nExample acceptance: --acceptance '["Tests pass", "No credentials in output"]'\n`:''}${['task claim','claim'].includes(command)?'\nChain is the default. Bootstrap claims need --intent-version and --base because a bootstrap cannot read the task. Use --lane ref for classic per-task allocation.\n':''}`;
}
