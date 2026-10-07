# @pumpkin-plugins/minecraft-colors

Chalk-like formatting for Minecraft strings, with no runtime dependencies.

```ts
import { color, colorTable } from '@pumpkin-plugins/minecraft-colors';

`Memory cache: ${color.aqua('100 B')}`;
color.gold.bold('The server is restarting');
color.hex('#12abef').underline('Custom color');
color.named.name('Pumpkin');
color.named.permission('plugin.manage');
colorTable(); // Log this string when debugging the palette.
```

The formatter returns section-sign codes such as `§b100 B`. Named colors use Minecraft's 16 legacy
colors. `hex()` emits the `§x` RGB format; modifiers are `bold`, `italic`, `underline`,
`strikethrough` and `obfuscated`. Styled strings end with `§r` to reset their formatting.

Colors and modifiers can be chained in either order. When multiple colors are chained, the last
color wins. Invalid hex colors throw a `RangeError`.

Use `color.named` for common value roles: `value` is gold, `name` and `url` are dark aqua,
`namespace` is dark green, `version` is green, and `permission`, `port`, `uuid` and `identifier` are
yellow. Permissions are bold. `colorTable()` returns a multiline table with every legacy color
shown in its own color, both normally and in bold; it is intended for debug output.

Pumpkin's native `TextComponent` API can style components directly with named colors, RGB, gradients
and rainbow effects. The plugin-kit command helpers parse returned strings with
`TextComponent.fromLegacyString()`, so these codes can be embedded in command response strings. Use
native components directly when building richer chat messages.
