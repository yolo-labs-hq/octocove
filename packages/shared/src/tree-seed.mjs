/** Tree-only materialization is not an admitted topology.
 * Check presence, not truthiness: partial/null evidence cannot opt into a graft.
 * canonicalAnchor is an alias of anchorCommit. */
export function hasTreeSeed(input) {
  return input !== null && typeof input === 'object' &&
    ['seedCommit', 'seedTree', 'anchorCommit', 'canonicalAnchor', 'transformVersion', 'sourceIdentity']
      .some(key => Object.hasOwn(input, key));
}
