/** Lane path and scope rules, shared by the engine and every `LaneFiles` implementation. */

/** The lane's own state beside the files: the sidecar, kept copies, upstream copies and the journal. Never lane content. */
export const LANE_DIR = '.octocove';
export const SIDECAR = `${LANE_DIR}/lane.json`;
/** Upstream copies of conflicted files live here: never in the write scope, never saved, never colliding with a repository path. */
export const INCOMING = `${LANE_DIR}/incoming`;
/** Pristine copies of what the lane holds, by content digest: the old side of a patch and the bytes a resumed save uploads. */
export const OBJECTS = `${LANE_DIR}/objects`;

/** Code points HFS+ ignores in names, so `.g‌it` opens `.git` there. */
const HFS_IGNORABLE = /[‌-‏‪-‮⁪-⁯﻿]/g;

/** Whether a name opens a Git metadata directory on some filesystem: `.git` in any case, with NTFS trailing dots or
 * spaces or an alternate data stream, NTFS's short name `git~1`, or HFS+ ignorable code points. */
export function gitMetadataName(segment: string) {
  const name = segment.replace(HFS_IGNORABLE, '').toLowerCase().replace(/:.*$/, '').replace(/[. ]+$/, '');
  return name === '.git' || name === 'git~1';
}

/** Repository-relative paths only: no absolute, dot-segment, backslash or NUL paths, no Git metadata, never the lane's own directory. */
export function validLanePath(path: string) {
  return typeof path === 'string' && path.length > 0 && path.length <= 4096 && !path.startsWith('/') && !path.endsWith('/') &&
    !/\0|\\/.test(path) && path.split('/').every((s) => s !== '' && s !== '.' && s !== '..' && !gitMetadataName(s)) &&
    path.split('/')[0]!.replace(HFS_IGNORABLE, '').toLowerCase() !== LANE_DIR;
}

/** A path of the lane's own state: under `.octocove/`, with a valid relative path beneath it. */
export const validStatePath = (path: string) => typeof path === 'string' && path.startsWith(`${LANE_DIR}/`) && validLanePath(path.slice(LANE_DIR.length + 1));

/** A recorded upstream copy: only names under `.octocove/incoming/` are honoured. */
export const validIncoming = (path: string) => typeof path === 'string' && path.startsWith(`${INCOMING}/`) && validLanePath(path.slice(INCOMING.length + 1));

/** Paths (or their directories) that differ only in letter case, as `[a, b]` pairs. */
export function caseCollisions(paths: Iterable<string>): [string, string][] {
  const seen = new Map<string, string>(), pairs: [string, string][] = [];
  for (const path of paths) {
    const parts = path.split('/');
    for (let i = 1; i <= parts.length; i++) {
      // Case-insensitive filesystems also fold Unicode normalization forms (macOS: NFD), so NFC first.
      const name = parts.slice(0, i).join('/'), folded = name.normalize('NFC').toLowerCase(), other = seen.get(folded);
      if (other === undefined) seen.set(folded, name);
      else if (other !== name && !pairs.some(([a, b]) => a === other && b === name)) pairs.push([other, name]);
    }
  }
  return pairs;
}

/** The whole-repository scope: the only entry of a read or write list that names it; never a path. */
export const ROOT_SCOPE = '.';
/** The server's scope rule: a prefix names itself and everything beneath it, and the root scope names every path. */
export const inScope = (path: string, prefixes: readonly string[]) =>
  prefixes.some((p) => p === ROOT_SCOPE || path === p || path.startsWith(p.endsWith('/') ? p : `${p}/`));
/** The whole-repository read scope, alone in its list. */
export const wholeRepository = (read: readonly string[]) => read.length === 1 && read[0] === ROOT_SCOPE;
