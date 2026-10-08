# Waypoint HUD preview

This build is ready for local preview testing. It is not a published release. The display protocol
is pinned to Minecraft Java 26.3 and was tested with Pumpkin `0.2.0+26.3-26.51`, using plugin API
`@pumpkinmc/pumpkin-api-ts` 0.1.1. Bedrock players can use waypoint commands but receive no HUD.

## Build and install

From the repository root, with the repository's pnpm toolchain installed:

```sh
pnpm install --frozen-lockfile
pnpm exec turbo run build --filter=@pumpkin-plugins/waypoints
```

Copy `packages/waypoints/build/waypoints.wasm` into the preview server's `plugins/` directory, then
restart Pumpkin and approve the plugin's declared permissions at the console. Preserve existing
`plugins/data/Waypoints/` files. Use a full restart when updating this preview: the tested host can
reject command permission registration after unloading and loading the plugin again.

Join with Java 26.3. Vanilla textures supply the built-in icons; no client waypoint mod or resource
pack is needed. The test client used mcp-fabric for observation and movement, not waypoint rendering.

As an operator, stand at a recognizable destination and run:

```mcfunction
/wp create "HUD Preview"
/wp access public "HUD Preview"
/wp set color "HUD Preview" 45C7E8
/wp set icon "HUD Preview" minecraft:compass
/wp set label "HUD Preview" Preview destination
```

New waypoints are restricted by default. The public command makes this demonstration visible to
other players; omit it for an operator-only demonstration. `/wp delete "HUD Preview"` removes it.

## What informed the polish

- [JourneyMap's waypoint settings](https://github.com/TeamJM/journeymap-docs/blob/6.0.x/docs/en/client/settings/waypoint-beacon.md)
  offer focused labels, small icons, backdrops, and minimum distance controls. This preview uses
  compact peripheral labels and an arrival fade.
- [BrainageHUD](https://github.com/brainage04/BrainageHUD) describes consistent apparent size and
  nearby or focused name visibility. This preview reveals names within 16 blocks or after a settled
  look, with separate enter/exit thresholds to prevent flicker.
- [Xaero's maintainer changelog](https://chocolateminecraft.com/update.php?mod_id=0) describes scaling
  by view-space depth to avoid enlarged labels in screen corners. The preview applies that principle
  to display scale while keeping marker positions independent of camera rotation.
- [Minecraft's display entity introduction](https://www.minecraft.net/en-us/article/minecraft-java-edition-1-19-4)
  documents billboards, interpolation, and text appearance. Metadata indices and serializers were
  checked against the pinned 26.3 registry and client, rather than copied from older protocol examples.

Client mods render using the current camera on every frame. Pumpkin supplies server position and
orientation samples at tick cadence. The preview therefore filters elevation, keeps horizontal
bearing responsive, interpolates over one client tick, and projects far markers up to 24 blocks
away. Its smooth depth curve avoids the movement-rate kink of the previous fixed eight-block clamp.
World anchoring blends in from 16 to three blocks, independently of name visibility.
Position jumps larger than eight blocks between samples reset elevation and focus history, preventing
stale visual state from drifting into place after a teleport.

## Preview checklist

1. Walk at least 30 blocks away. Look directly at the marker, then away: a far name should reveal
   after roughly 300 ms and collapse to distance plus icon. Small focus-boundary movements should
   not flicker. Within 16 blocks, the name should remain visible without focusing it.
2. Walk forward, strafe, climb steps, and jump. Expect responsive horizontal bearing and damped
   ordinary vertical motion. A destination substantially above or below you should still be findable.
3. Rotate away and return while stationary. The marker should retain its position and entity identity;
   it should not fly outward or glide back into view.
4. Approach and retreat. Size should remain consistent at a fixed FOV. The marker should blend
   continuously to its world anchor and stay there within three blocks. Inside two blocks, text,
   icon, and backdrop should fade together, disappearing at 0.75 blocks.
5. Check visibility with a second player, a restricted waypoint, a range limit, and a disabled
   waypoint. Unauthorized, out-of-range, wrong-dimension, and disabled markers must be absent.
6. Inspect names, colors, icons, and long labels against bright sky and dark terrain. HUD truncation
   must not change stored names or `/wp info` output.
7. Teleport within the dimension to a substantially different height and bearing. Markers should
   start at the new bearing without carrying elevation or focus state from the previous location.

Unit coverage checks camera independence, forward movement, vertical damping, transition continuity,
apparent size, focus hysteresis, arrival opacity, ACLs, packet encoding, and unavailable Java handles.
Real Pumpkin integration tests pass. Live mcp-fabric checks covered name reveal, camera turns, forward
movement, world anchoring, arrival fade, teleport history reset, and spyglass behavior without packet
decoding failures.

## Known limits and remaining validation

- Spyglass and modded zoom enlarge labels. Client FOV and reliable Java item-use state are absent
  from the pinned API; the server cannot perform accurate zoom compensation. Third-person camera
  offsets and view bobbing are also unavailable.
- Network delay still causes relative motion. The farther projection reduces this error but cannot
  provide frame-accurate camera attachment. High-latency clients need dedicated preview testing.
- Same-bearing waypoints at different positions can overlap. Only waypoints in the same half-block
  grid cell receive a deterministic vertical stack.
- Scale, focus, fade, and damping thresholds currently have no user configuration. Broad FOV,
  resource-pack, multiplayer load, and accessibility testing remain before general release.
- Client mod synchronization, other Java display protocols, Bedrock HUD rendering, and locator bars
  are outside this preview. The waypoint model remains independent of these presentation choices.
