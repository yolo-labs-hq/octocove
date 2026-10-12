// Nearest-rank percentiles on small samples. No interpolation: with 7 samples the
// p95 is the max, which is the conservative reading we want for a go/no-go.
export function percentile(values, p) {
  if (!Array.isArray(values) || values.length === 0) return null;
  if (p < 0 || p > 100) throw new RangeError("p must be within [0, 100]");
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1];
}

export function summarize(values) {
  if (values.length === 0) return { n: 0, min: null, p50: null, p95: null, max: null, mean: null };
  const sum = values.reduce((a, b) => a + b, 0);
  return {
    n: values.length,
    min: Math.min(...values),
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    max: Math.max(...values),
    mean: Math.round(sum / values.length),
  };
}
