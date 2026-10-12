// Generation ids are UTC timestamps: 20261004T020000Z.
export const DEFAULT_RETENTION = { daily: 30, weekly: 8, monthly: 12 };

export function generationId(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

export function parseGeneration(id) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(id);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
}

const day = d => d.toISOString().slice(0, 10);
const month = d => d.toISOString().slice(0, 7);
const week = d => { // Monday of the UTC week
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7));
  return day(x);
};

function pick(sortedDesc, bucket, limit, keep) {
  const seen = new Set();
  for (const id of sortedDesc) {
    const b = bucket(parseGeneration(id));
    if (seen.has(b)) continue;
    if (seen.size >= limit) break;
    seen.add(b); keep.add(id);
  }
}

/** Newest generation per day/ISO-week/month is kept; protected ids (last verified) always survive. */
export function selectRetention(completeIds, policy = DEFAULT_RETENTION, protect = []) {
  const sorted = completeIds.filter(i => parseGeneration(i)).sort().reverse();
  const keep = new Set(protect.filter(p => completeIds.includes(p)));
  if (sorted.length) keep.add(sorted[0]);
  pick(sorted, day, policy.daily, keep);
  pick(sorted, week, policy.weekly, keep);
  pick(sorted, month, policy.monthly, keep);
  return { keep: [...keep].sort(), prune: sorted.filter(i => !keep.has(i)).sort() };
}
