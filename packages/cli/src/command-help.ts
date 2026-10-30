import { statusHelp } from './status-help.js';
/** Command-specific help is pure data: no config, Git, network or credential reads. */
const FLAGS: Record<string,string> = {
  acceptance: 'JSON array of strings, for example \'["Tests pass", "Help describes every flag"]\'. Quote the array as one shell argument.',
  task: 'Task ID.',
  title: 'Short human-readable task title.', description: 'Task intent and implementation context.',
  project: 'Project ID, not a slug (`project list --verbose` shows it); a PROJECT argument takes the slug or the ID.', repository: 'Canonical repository ID for the task.',
  'target-ref': 'Full canonical branch ref, for example refs/heads/main.', key: 'Unique task key within the project.',
  'expected-head': 'The SHA the branch must be at now (40 hex); refused as target-ref-moved otherwise.',
  'from-ref': 'Full branch ref the new branch is created from, for example refs/heads/main.',
  at: 'The pinned commit (40 hex): the --from-ref branch must be at it now; refused as source-ref-moved otherwise.',
  'change-note': 'Reason for editing the intent contract.', 'intent-version': 'Current positive intent version; rejects a stale contract.',
  'expected-status': 'Exact current task status required for this transition.', upstream: 'Upstream task ID whose landed receipt this task requires.',
  replacement: 'Task ID replacing this task.', claim: 'Exact claim ID (a human names it; an agent\'s comes from its delegation).',
  'expires-at': 'Delegation/claim expiry as an absolute <RFC 3339 timestamp> in UTC (ending in Z); choose a future time within server policy.',
  agent: 'Opaque agent ID chosen by the delegating human: nonempty, at most 128 characters. No agent registration or human login is required for this label. Use a separate agent config directory and its own bootstrap; this does not change the signed-in human.',
  verbs: 'Comma-separated permission names. The human must hold every permission granted; no permissions are implied.',
  read: 'Lane read scope: comma-separated repository path prefixes (a directory prefix ends with /), or . alone for the whole repository. Left out when continuing a reopened lane, which keeps its granted scope.',
  write: 'Lane write scope: comma-separated prefixes, each inside a read prefix, or . alone for the whole repository (needs --read .).',
  message: 'Message for the save point or wrap-up (the wrap-up subject defaults to the first save point\'s); the server appends its own trailers.',
  resolve: 'PATH=lane|base|FILE for a path the last refused refresh or wrap-up listed; repeat once per path. lane keeps the saved lane version, base takes upstream, FILE uploads that local file as the result. Sent under a new idempotency key.',
  'allow-unsaved': 'Wrap up the saved lane head even though the directory has unsaved edits (they stay local and are not part of the candidate).',
  handover: 'Hand the claim\'s open execution over to this environment first: the new execution inherits the lane head, its delegation is stored privately as the agent credential, and the other environment\'s credential stops working (execution-superseded).',
  out: 'Write the patch to this new file instead of .octocove/unsaved-TIME.patch in the lane directory.',
  reason: 'Why the lane is reopened; recorded with the reopen.', 'expected-receipt': 'The task\'s newest landed receipt; defaults to the one the task reports.',
  dir: 'Lane directory of this task; unsaved edits there are written to a patch first. Defaults to the working directory when it is one.',
  keep: 'Conflict decision: local keeps your edit and drops the upstream copy; incoming takes the upstream copy.',
  'bootstrap-out': 'Write the bootstrap directly to this new file (0600, parent 0700). Existing files and symlinks are refused before authorization. Choose a private path outside all working trees; only the path is printed.',
  'bootstrap-file': 'Protected authorization hand-off file. Claim it within about 5 minutes of authorization; it is replaced by the scoped agent delegation.',
  wait: 'Bounded wait in seconds (default 120); land/receipt --wait is a boolean that waits for a receipt.',
  submission: 'Submission ID whose candidate should be shown.',
  'candidate-sha': 'Exact candidate commit SHA being approved.', 'base-sha': 'Exact approved canonical base commit SHA.',
  note: 'Optional human approval note.', approval: 'Approval ID bound to this exact candidate and base.',
  after: 'Exclusive event/delivery cursor to start after.', through: 'Inclusive final event cursor to replay through.',
  from: 'Starting live-event cursor.', checkpoint: 'Local file for resumable event cursors.', follow: 'Follow the project event stream until interrupted.',
  limit: 'Maximum number of records in one page; server bounds apply.', cursor: 'Opaque continuation cursor from the previous page.',
  status: 'Filter by record status; permitted values appear in Usage.', name: 'Human-readable project/repository name (repo add --provider github: the GitHub repository name).',
  principal: 'Existing principal ID to add to this project.', role: 'Member role: member (default) or approver.',
  namespace: 'Artifacts namespace for an existing canonical repository.', repo: 'Artifacts repository ID.', head: 'Exact known head SHA of the target ref.',
  seed: 'Create an initial README commit; create mode only, default false.', import: 'Credential-free HTTPS source to import; cannot be combined with --seed.',
  branch: 'Branch to import from the source.', url: 'HTTPS webhook destination.', types: 'Comma-separated webhook event types.',
  'secret-stdin': 'Read the webhook signing secret from stdin; never place it in arguments.', delivery: 'Exact delivery ID to redrive.',
  'overlap-seconds': 'Seconds to accept the previous webhook secret during rotation.',
  as: 'Expected machine principal ID; never an actor override.', scope: 'Exact machine grant scope as one JSON object.',
  grant: 'Protected approval grant ID; activates the headless path.',
  provider: 'Repository provider: artifacts (default), github (operator credential) or github-app (your connected GitHub App installation).', owner: 'GitHub repository owner (user or organization).',
  installation: 'GitHub App installation ID you connected (see Settings > Connected apps); repo add --provider github-app.',
  'repo-id': 'GitHub numeric repository ID; when given it decides which repository is meant, across renames.',
  'credential-ref': 'Opaque reference of an operator-held GitHub credential (never a token); sent, never printed.',
  'api-base-url': 'GitHub REST base (default https://api.github.com; GitHub Enterprise Server: https://HOST/api/v3).',
  'clone-base-url': 'Git clone base (default https://github.com).',
  slug: 'Organization slug: 1-39 lowercase letters, digits and single hyphens (for example acme-labs), unique across organizations and user handles; org create derives one from NAME when omitted.',
  org: 'Org ID (org_<uuid>) the command acts in; `project list` shows each project\'s org. Also OCTOCOVE_ORG.',
  publication: 'How a submitted candidate becomes visible: repository-readers, or public-on-submit (required for a public repository).',
  visibility: 'The repository\'s declared visibility: private or public.',
  'token-stdin': 'Read workload proof from stdin instead of OCTOCOVE_WORKLOAD_TOKEN.', timeout: 'Machine command deadline in seconds, 1–300 (default 30).',
};
const POSITIONALS: Record<string,string> = {
  PROJECT:'Project slug or ID.', REPOSITORY:'Repository ID (clone also accepts a name; optional only when exactly one canonical exists).',
  DIR:'Destination directory; defaults to repository name. Must be absent or empty.', SLUG:'URL-safe project slug.',
  NAME:'Organization display name (1-120 characters; not unique, never an org ID).',
  ORG:'Organization ID (org_<uuid>), or its current or a retired slug (`org list` shows both).',
  CANDIDATE_ID:'Candidate ID to land (not a task ID).',
  TASK:'Task ID (lane materialize: of an active claim; lane reopen: a landed task; lane retire: a landed, rejected or superseded task).', PATH:'Repository-relative path of an unresolved conflict.',
  FILE:'With --resolve PATH=FILE: a local file whose content resolves the conflict at PATH.', DELEGATION_ID:'Delegation ID to revoke; defaults to the active delegation.',
};
const MINIMUM_VERBS = `Minimum agent workflow permissions (pass all seven explicitly):
  tasks:list          list project tasks
  tasks:read          read intent, the pinned base and the lane state
  tasks:claim         claim the authorized task
  claims:read         inspect claim authority and provisioning
  submissions:create  save and wrap up the agent's lane
  candidates:read     poll and inspect the computed candidate
  receipts:read       read landing receipts
Example: --verbs tasks:list,tasks:read,tasks:claim,claims:read,submissions:create,candidates:read,receipts:read

The bootstrap expires about 5 minutes after authorization. Use its file to claim promptly.
--expires-at controls the longer-lived delegation expiry ceiling, not the bootstrap window. Delegation tokens last about 15 minutes and renew automatically within that ceiling and the claim lease.
The human alone approves; do not grant approval authority to a worker.`;

export function commandHelp(command: string, originalUsage: string, description = '') {
  let usage = originalUsage;
  if (command === 'auth revoke') usage = 'auth revoke [DELEGATION_ID] [--grant ID --timeout SECONDS]';
  if (command === 'auth renew') description = 'Rotate the active credential explicitly. Stored human and agent tokens also renew automatically near expiry; agent renewal stays within its authorization ceiling and claim lease. Revoked or ended grants require a new authorization.';
  if (command === 'auth exchange') usage += ' [--timeout SECONDS]';
  if (command === 'approve') usage += ' [--grant ID --as ID --timeout SECONDS]';
  if (command === 'auth approve') usage = 'auth approve --grant ID [--as ID] [--timeout SECONDS]';
  if (command === 'auth revoke') description = 'Revoke a delegation (defaults to the active one); --grant revokes an approval grant as a human administrator.';
  if (command === 'events') usage += ' [--limit N]';
  const optionMatches = [...usage.matchAll(/--([a-z][a-z-]*)(?: ([A-Z][A-Z_]*|[a-z]+(?:\|[a-z]+)+|a,b))?/g)];
  const options = [...new Map(optionMatches.map(m=>[m[1]!,m[0]])).entries()].map(([flag,label])=> {
    let detail = FLAGS[flag];
    if (flag === 'wait' && ['land','receipt show'].includes(command)) detail = 'Wait for the final receipt (boolean flag, no value).';
    if (flag === 'wait' && command === 'login') detail = 'Browser-consent wait in seconds (default 600).';
    if (flag === 'wait' && command === 'org create') detail = 'How long to wait for a new organization to be provisioned, in seconds (default 120).';
    if (flag === 'wait' && ['lane refresh','lane wrap-up'].includes(command)) detail = 'Bounded wait in seconds (default 150), including any wait for another save, refresh or wrap-up settling on the lane.';
    if (!detail) throw new Error(`missing option help: ${command} --${flag}`);
    return `  ${label.padEnd(28)} ${detail}`;
  });
  const positionalUsage=usage.slice(command.length).replace(/--[a-z-]+(?: [A-Z][A-Z_]*| [a-z]+(?:\|[a-z]+)+| a,b)?/g,'');
  const args=[...new Set(positionalUsage.match(/\b[A-Z][A-Z_]*\b/g)??[])].map(name=>`  ${name.padEnd(28)} ${(name==='DIR'&&command.startsWith('lane ')&&command!=='lane materialize'?'Materialized lane directory; defaults to the working directory.':undefined) ?? (name==='DIR'&&command==='lane materialize'?'Directory to write the lane into; defaults to TASK. Must be absent or empty.':undefined) ?? POSITIONALS[name] ?? (command==='task claim-status'?'Claim ID (not a task ID).':command.startsWith('receipt ')?'Receipt ID.':command.startsWith('webhook ')?'Webhook subscription ID.':command.startsWith('project ')?'Project ID.':command==='approve'?'Candidate ID to approve.':'Task ID for this command.')}`);
  return `Usage: octo ${usage}\n${description?`\n${description}\n`:''}${args.length?`\nArguments:\n${args.join('\n')}\n`:''}\nOptions:\n${options.join('\n') || '  This command has no command-specific flags.'}\n${command==='task authorize'?`\n${MINIMUM_VERBS}\n`:''}${['candidate show','task show'].includes(command)?`\n${statusHelp()}\n`:''}${command==='approve'?'\nWith --grant, use only ID, --grant, --as, --timeout and global JSON/idempotency options. The protected grant supplies the exact candidate and approval fields.\n':''}${['task create','task edit'].includes(command)?`\nExample acceptance: --acceptance '["Tests pass", "No credentials in output"]'\n`:''}${['task claim','claim'].includes(command)?'\nA claim presents the one-use claim bootstrap a human issued (task authorize or lane reopen) within about 5 minutes; it needs --intent-version because a bootstrap cannot read the task. The claim\'s agent delegation replaces the bootstrap in this config directory. Next: octo lane materialize TASK DIR.\n':''}`;
}
