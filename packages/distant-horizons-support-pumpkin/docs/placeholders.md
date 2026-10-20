<!-- docs:begin placeholders -->
<!-- Generated from src/placeholders/definitions.ts and the PumpkinPIE session timing constants. Run `pnpm readme`. -->

# PumpkinPIE placeholders

Distant Horizons Support optionally registers the `dhs` namespace with PumpkinPIE. Every
placeholder takes no argument and returns an unlocalized base-10 string. A known zero is `0`.
Unknown names and supplied arguments are declined.

| Placeholder | Meaning |
| --- | --- |
| `%dhs_client_connected%` | Whether the exact supplied viewer name has an active Distant Horizons session; true or false. |
| `%dhs_clients%` | Active Distant Horizons client sessions. |
| `%dhs_pending_requests%` | Number of pending LOD requests. |
| `%dhs_worker_ticks%` | Number of Distant Horizons worker ticks processed. |
| `%dhs_served%` | Number of LOD requests served. |
| `%dhs_rejected%` | Number of LOD requests rejected. |
| `%dhs_cancelled%` | Number of LOD requests cancelled. |
| `%dhs_packet_bytes_sent%` | Cumulative Distant Horizons packet bytes sent. |
| `%dhs_cache_refreshes%` | Number of current background cache refreshes. |
| `%dhs_memory_entries%` | Number of entries in the memory cache. |
| `%dhs_memory_bytes%` | Cached LOD payload byte lengths in memory, excluding JavaScript object overhead. |
| `%dhs_memory_limit%` | Memory cache entry limit; -1 means unlimited and 0 means disabled. |
| `%dhs_memory_byte_limit%` | Memory cache byte limit set by memory_cache_mb. |
| `%dhs_disk_entries%` | Number of entries indexed in the disk cache. |
| `%dhs_disk_bytes%` | Bytes indexed in the disk cache. |
| `%dhs_disk_limit%` | Disk cache entry limit; -1 means unlimited and 0 means disabled. |

All placeholders except `%dhs_client_connected%` work with or without a viewer.
`%dhs_client_connected%` uses the exact, case-sensitive player name supplied by PumpkinPIE
and returns `false` when that name has no active DH session. It is declined when no viewer is
supplied. The viewer name is status context, not an authorization check.

These values are available to trusted plugins that can resolve PumpkinPIE placeholders; they
do not inherit the operator permissions for `/dhs` commands.

For example, a scoreboard or chat format can include:

```text
DH clients: %dhs_clients%; pending LOD requests: %dhs_pending_requests%
Memory cache: %dhs_memory_bytes% bytes across %dhs_memory_entries% entries
My DH session: %dhs_client_connected%
```

PumpkinPIE is optional. Without it, Distant Horizons Support still loads and handles DH
traffic. The plugin probes for PumpkinPIE with bounded exponential retry; after retries reach
the cap, another attempt is scheduled no sooner than 5 minutes later. It recovers automatically
on a scheduled attempt after PumpkinPIE becomes available. A ready integration sends its
heartbeat every 30 seconds. No PumpkinPIE dependency is required in the host plugin metadata.
<!-- docs:end placeholders -->
