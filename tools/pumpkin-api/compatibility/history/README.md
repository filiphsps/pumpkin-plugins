# Compatibility audit history

Use these snapshots to see which API compatibility decisions were reviewed for a particular
Pumpkin release and upstream WIT revision. The refresh command keeps the previous reviewed matrix
when the WIT revision changes, so you can compare it with the new candidate without losing the
audit for the earlier revision.

Each file is grouped by Pumpkin release and WIT package directory. Its name combines the upstream
Git commit with the SHA-256 digest of the fetched WIT files:

```text
<pumpkin-release>/<wit-subdirectory>/<commit>-<wit-sha256>.json
```

The commit identifies the pinned source revision; the digest identifies the exact WIT content used
for the audit. Both are part of the path so snapshots remain distinguishable if content differs.
Snapshots are immutable: refresh writes a new snapshot and refuses to replace an existing one with
different content. The active matrix is `../v0.1.1.json`; it can be updated while that Pumpkin
release is current.

After changing `wit.lock.json`, run
`pnpm --filter @pumpkin-plugins/static-hermes-runtime compatibility:refresh`. When the revision has
changed, the command archives the previous matrix before writing the new candidate. It archives
only a fully reviewed matrix, so resolve every pending compatibility decision and migration note
before refreshing.
