# AppleSkinPumpkin

AppleSkinPumpkin sends Java Edition clients the current saturation, exhaustion, and food-healing
state that AppleSkin needs for its HUD. Install the AppleSkin client mod separately; this server
plugin supplies the live values.

## Install

Place `apple-skin-pumpkin.wasm` in the Pumpkin server's `plugins/` directory and restart the server.
The first load asks for the plugin's permissions in the server console. A hot reload cannot show
that prompt.

## What clients receive

The plugin checks online players once per tick and sends an update only when one of the tracked
values changes. Vanilla does not regularly send saturation and exhaustion updates in the form the
AppleSkin HUD needs, so the plugin provides those updates directly. Bedrock players are skipped;
AppleSkin is a Java Edition mod.

## Diagnose updates

Set `log.level` to `debug` in the Pumpkin server configuration to see the values sent, plus join,
leave, and skip events. Ticks with no changes stay quiet. The plugin has no separate configuration
file or player commands.
