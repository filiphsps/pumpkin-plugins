---
navigation:
    category: Gameplay
---

# TabDisplay

TabDisplay formats the Java player list: it gives every listed player's name the same template and
style, and shows each Java player their own header and footer lines. Bedrock players keep Pumpkin's
normal player list.

Install `tab-display.wasm` in the server's `plugins/` directory and restart. TabDisplay creates
`plugins/data/TabDisplay/config.toml` on the first start. It needs `fs.read.data` and `fs.write.data`
for that file, and `http.outbound` for the usual Pumpkin Market update check.

## What it changes

| Part of the player list | What TabDisplay does |
| --- | --- |
| Java row names | Applies `entry.text` and its style to every listed player |
| Java header and footer | Renders `header.lines` and `footer.lines` for each viewer |
| Bedrock player list | Leaves it unchanged |

TabDisplay doesn't sort the list, add score columns, add fake rows or show different row names to
different viewers. It never changes player identities, skins or who appears in the list.

## Placeholders

Templates can contain tokens such as `%player_name%`. Without any other plugin, TabDisplay fills in
two of them itself: `%player_name%` and `%server_online%`, the number of players online. That covers
the default config, so a fresh install shows real names and counts.

Every other token needs [PumpkinPIE](https://github.com/Rennex07/PumpkinPIE/releases), a separate
plugin that TabDisplay doesn't bundle. Install a PumpkinPIE release built for your Pumpkin version
next to TabDisplay. `placeholders.provider` is the plugin name TabDisplay asks for values.

While PumpkinPIE isn't running, `placeholders.missing_provider` decides what the other tokens show:
`literal` leaves the token text in place and `empty` removes it. Tokens PumpkinPIE doesn't know
follow `placeholders.unresolved` in the same way.

Header and footer tokens are filled in for the player looking at the list. Row-name tokens are filled
in for the player in that row. Placeholder values are always shown as plain text, so a value can't
add formatting or clickable commands.

If PumpkinPIE stops answering, TabDisplay keeps showing the last complete result for up to 30
seconds, then switches to the fallback text above.

## Commands and config changes

The `/tabdisplay` commands are for operators by default:

- `/tabdisplay status` shows whether PumpkinPIE is connected, how many Java and Bedrock players are
  online, their Java versions, unknown placeholder tokens and the last problem TabDisplay hit.
- `/tabdisplay reload` applies changes to `config.toml`. If the file has invalid TOML or an invalid
  value, the reload lists the problems and keeps the current settings.
- `/tabdisplay inspect <player>` shows which placeholder tokens apply to one player. It doesn't show
  their values.

At startup, an invalid value falls back to its default and TabDisplay logs a warning; if the file
isn't valid TOML, every setting uses its default. TabDisplay never rewrites a file that has invalid
values, so your edits stay in place for you to fix.

## Turning it off

Set `general.enabled = false` and reload to undo all of TabDisplay's changes for online players, or
set `entry.enabled = false` to undo only the row names. Unloading the plugin undoes them too. A row
name goes back to what it was before TabDisplay changed it, unless another plugin has changed it
since; that newer name is left alone. Pumpkin has no way to read the previous header and footer, so
TabDisplay clears them.

## Limits

TabDisplay refreshes the list every `general.refresh_ticks` ticks, 20 by default. It works on at most
`general.max_players` online players, 500 by default and 5,000 at most. When more players are online
than that, it stops updating and logs a warning, then logs again and carries on once the count drops.

Each tick sends PumpkinPIE at most one batch of 256 placeholder requests, and no batch is larger
than 1 MiB. A rendered line longer than 8 KiB is cut to fit. These limits keep each tick's work
bounded, but nobody has measured their effect on server TPS yet.
