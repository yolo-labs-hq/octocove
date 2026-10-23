import type { components } from '../../client/src/generated/openapi.js';

type Schemas = components['schemas'];
// Exhaustive typed tables keep help aligned with the generated client vocabulary.
const tasks = {
  draft: 'Intent is editable and unpublished (or waiting on dependencies). Next: finish intent/dependencies, then publish.',
  ready: 'Published and available for work. Next: claim the task.',
  claimed: 'An attempt owns the work. Next: materialize the lane, edit, save with lane submit, then lane wrap-up.',
  submitted: 'Work was wrapped up; computation is pending. Next: wait and inspect candidate show.',
  candidate: 'A candidate awaits human review. Next: inspect changes/checks and approve the exact candidate.',
  approved: 'An approval exists; its bindings must still be current. Next: land with that approval, or review again if stale.',
  landing: 'Landing holds a fence and is in progress. Next: wait for the receipt; do not replace or cancel the attempt.',
  landed: 'The accepted result reached canonical. Next: inspect the receipt and stop this attempt.',
  rejected: 'The task was closed without acceptance. Next: stop work on this task.',
  superseded: 'Another task replaces this one. Next: stop and follow the replacement.',
  reopened: 'A human reopened the landed lane for more work. Next: the authorized agent claims with the reopen bootstrap, saves and wraps up again; a new landing gets its own receipt.',
} satisfies Record<Schemas['TaskStatus'], string>;
const candidates = {
  active: 'Current candidate; reviewable when bindings and checks permit. Next: human review/approve, then land.',
  fenced: 'Reserved by an in-progress landing. Next: wait for its receipt; do not wrap up a replacement for this landing.',
  landed: 'This candidate landed. Next: inspect its receipt and stop this attempt.',
  raced: 'Canonical moved during landing. Next: wrap up again (it squashes onto the current head) and seek a new approval.',
  failed: 'No usable candidate was computed. Next: stop approval/landing, inspect the outcome, fix the cause in the lane and wrap up again.',
  superseded: 'A newer wrap-up or save point replaced this candidate. Next: stop using it and inspect the latest submission.',
  stale: 'The candidate no longer matches current canonical or review bindings. Next: wrap up again; review anew.',
  withdrawn: 'The candidate was withdrawn. Next: stop using it; wrap up revised work only while the attempt permits it.',
  rejected: 'The candidate was rejected. Next: stop using it and inspect the task before doing more work.',
} satisfies Record<Schemas['Candidate']['status'], string>;
const outcomes = {
  computed: 'Computation produced a candidate. Next: inspect its status and checks before human approval.',
  conflict: 'The merge conflicts; candidate status is failed. Next: stop approval, then wrap up again with a --resolve for each listed path.',
  'stale-base': 'The base the candidate was built on is no longer usable. Next: wrap up again.',
  'stale-head': 'Canonical moved during computation. Next: wrap up again.',
  error: 'Computation failed. Next: stop approval, inspect the error, fix the cause in the lane and wrap up again.',
} satisfies Record<Schemas['Candidate']['outcome'], string>;
const states = {
  pending: 'Computation is queued/running, or staged behind a landing fence. Next: wait and poll candidate show.',
  complete: 'Computation finished; this does not mean landed. Next: inspect candidate status and outcome.',
  superseded: 'The submission was replaced. Next: stop polling it and inspect replacementSubmissionId.',
} satisfies Record<Schemas['CandidateResult']['state'] | Schemas['CandidatePending']['state'], string>;

export function statusHelp() {
  const rows = (title: string, values: Record<string,string>) => `${title}:\n${Object.entries(values).map(([key,value])=>`  ${key.padEnd(14)} ${value}`).join('\n')}`;
  return 'Status vocabulary (separate client fields; "reviewable" describes active, not another status):\n'
    + [rows('Candidate response state',states),rows('Task status',tasks),rows('Candidate status',candidates),rows('Candidate compute outcome',outcomes)].join('\n\n') + '\n';
}
