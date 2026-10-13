# Compatibility audit history

The JSON files here preserve reviewed compatibility matrices that were active before a Pumpkin release or upstream WIT pin changed. Each snapshot is stored under its Pumpkin release and named with the upstream Git commit and the SHA-256 digest of the fetched WIT files:

```text
<pumpkin-release>/<wit-subdirectory>/<commit>-<wit-sha256>.json
```

Snapshots are immutable. The active matrix stays at `../v0.1.1.json` and may be updated while its Pumpkin release is current. Run `pnpm --filter @pumpkin-plugins/static-hermes-runtime compatibility:refresh` after changing `wit.lock.json`; the command archives the prior reviewed matrix before writing the new candidate.
