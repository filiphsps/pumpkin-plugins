# @pumpkin-plugins/minecraft-colors

Chalk-like formatting for Minecraft strings, with no runtime dependencies.

```ts
import { minecraft } from '@pumpkin-plugins/minecraft-colors';

`Memory cache: ${minecraft.aqua('100 B')}`;
minecraft.gold.bold('The server is restarting');
minecraft.hex('#12abef').underline('Custom color');
```

The formatter returns section-sign codes such as `§b100 B`. Named colors use Minecraft's 16 legacy
colors. `hex()` emits the `§x` RGB format; modifiers are `bold`, `italic`, `underline`,
`strikethrough` and `obfuscated`. Styled strings end with `§r` to reset their formatting.

Colors and modifiers can be chained in either order. When multiple colors are chained, the last
color wins. Invalid hex colors throw a `RangeError`.

Pumpkin's native `TextComponent` API can style components directly with named colors, RGB, gradients
and rainbow effects. The plugin-kit command helpers parse returned strings with
`TextComponent.fromLegacyString()`, so these codes can be embedded in command response strings. Use
native components directly when building richer chat messages.
