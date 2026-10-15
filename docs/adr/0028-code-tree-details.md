# Bounded code tree details

Status: Accepted

Directory listings may include `entries[].lastCommit`, `lastCommitTruncated`,
`sizeTruncated` and `readme`. These fields are optional for compatibility with older
servers. Last-commit metadata describes the most recent entry change along the
selected commit's first-parent history. Implementations bound history, tree reads
and entry work; they omit unproven metadata and report truncation rather than
attribute a guessed commit. Committer time and author name may be unknown.

Listing sizes use object metadata or bounded HEAD requests. They never require
reading blob bodies merely to count bytes. Missing metadata leaves `size` absent
and sets `sizeTruncated`.

README content is complete UTF-8 text, capped at 256 KiB, from a regular file in
the listed directory. Preference order is README.md, README, then readme.md.
Missing, binary and larger files are omitted. The blob operation at `commitSha`
and the entry's path remains available for individual files.

Commit items may carry `landingId` and `taskId` when an accepted receipt records
that exact landed SHA in the same repository. An ancestor relationship alone is
not provenance. These are display links, not an authorization grant. Named refs
retain no-store caching; SHA reads retain their existing immutable caching.
