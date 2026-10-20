# AppleSkinPumpkin

AppleSkinPumpkin keeps AppleSkin's hunger HUD in sync with the server. It sends Java Edition clients
their saturation and exhaustion values, along with whether their world uses natural health
regeneration. Players still need the AppleSkin client mod; this plugin supplies the server-side
values it needs.

## Install

Place `apple-skin-pumpkin.wasm` in the Pumpkin server's `plugins/` directory, then restart the
server. On first load, Pumpkin asks for the plugin's permissions in the server console. Hot reload
can't show that prompt.

## What clients receive

At the end of each server tick, the plugin checks every online player and sends updated values when
saturation changes or exhaustion moves far enough to matter. Vanilla doesn't regularly send these
values in the form AppleSkin needs, so the plugin sends them directly. It also tells AppleSkin
whether natural health regeneration is enabled in the player's world. Bedrock players are skipped
because AppleSkin is a Java Edition mod.

## Diagnose updates

Set `logging.level` to `debug` in the Pumpkin server configuration to see the values sent and when
players join, leave, or are skipped. After a line for the first tick, ticks without updates stay
quiet. The plugin has no separate configuration file or player commands.
