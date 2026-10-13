---
navigation:
    category: Gameplay
---

# TabDisplay

TabDisplay customizes Pumpkin's native Java player list with formatted real-player names and
per-viewer headers and footers. It keeps the native roster and latency behavior. Bedrock players
continue to see Pumpkin's unchanged player list.

Install `tab-display.wasm` in the server's `plugins/` directory and restart. TabDisplay creates
`plugins/data/TabDisplay/config.toml`. It requests `fs.read.data` and `fs.write.data` for that file;
the normal Pumpkin Market update check also requests `http.outbound`.

## Current capability boundary

The Java adapter currently makes tab-name and header/footer calls only for Java protocol
`v-26-3`. It leaves other Java versions unchanged and reports them as unsupported in
`/tabdisplay status`. These adapter calls have not been verified with a live Java client in this
environment. Status and documentation do not claim that a live client displayed the result.

Native sorting is disabled. Non-empty `sorting.rules` values fail config validation because the
client's ordering direction has not been verified. Numeric objectives are also rejected until their
player-list display behavior is verified. The Bedrock adapter does not send Java tab fields or
modify names, scores, identities, skins or roster membership.

| Surface | Current behavior |
| --- | --- |
| Java row names | Global subject formatting, gated to `v-26-3`; live client behavior unverified |
| Java header/footer | Per-viewer formatted lines, gated to `v-26-3`; live client behavior unverified |
| Java sorting | Disabled; config rejects non-empty rules |
| Java numeric objective | Disabled; config rejects `objective.enabled = true` |
| Bedrock roster | Left unchanged; objective and row formatting unsupported |
| Per-viewer row names, fake rows and fixed slots | Not implemented |

## PumpkinPIE placeholders

PumpkinPIE is an optional external plugin, built and released separately from TabDisplay. TabDisplay
talks to the configured plugin name through the shared PumpkinPIE client API and does not require
the provider as plugin metadata. If it is absent, the display
commands still work and templates use the configured `placeholders.missing_provider` fallback
(`literal` by default, or `empty`). Once the provider returns, one shared session resumes bounded
placeholder work. Unknown identifiers follow `placeholders.unresolved`.

Install only a PumpkinPIE artifact compatible with the server and plugin API versions. Confirm its
release provenance from the provider's official distribution before installing it; no provider source
or binary is bundled here. Real-IPC integration against a provenance-verified provider artifact is
still pending.

Header and footer templates use the viewer's context. A row-name template uses the listed subject's
context. Placeholders receive a player's current name only at the request boundary; internal state
uses UUIDs. Provider output is rendered as literal text and cannot inject formatting JSON or
clickable commands.

## Configuration and ownership

Use `/tabdisplay reload` to validate and apply `config.toml`. Invalid TOML or unsupported settings
leave the running config and file contents untouched. `/tabdisplay status` reports provider state,
connected Java versions, unsupported capabilities and unresolved placeholder identifiers.
`/tabdisplay inspect <player>` reports safe per-player context and placeholder IDs; it never displays
resolved placeholder values.

The commands are operator-only by default. A row name is restored on disable, reload that turns row
formatting off, disconnect or unload only while the current value still matches TabDisplay's last
write. If another plugin changes the name, TabDisplay releases ownership and leaves that value alone.
Headers and footers have no getter for original state in the pinned API; TabDisplay clears them to
empty on disable or unload under exclusive ownership. Native order resets to zero if later enabled
after a verified probe.

## Work limits and measurements

Defaults refresh templates every 20 ticks and snapshot at most 500 players; `general.max_players` is
bounded at 5,000. Placeholder resolution processes at most 256 requests and 1 MiB per batch on a
tick. Rendered fields are capped at 8 KiB. When the provider is unavailable, the last successful
frame is retained for up to 30 seconds before configured fallback text is applied.

No server TPS or client display performance benchmark has been collected. The work limits bound
individual snapshots and placeholder batches, but they are not a measured capacity claim.
