# Minecraft colors

`@pumpkin-plugins/minecraft-colors` formats text for two destinations: Minecraft legacy text
components and ANSI terminal output. It has no runtime dependencies.

```ts
import { ansi, color } from '@pumpkin-plugins/minecraft-colors';

const chat = color.gold.bold('Server restarting');
const consoleLine = ansi.named.port('25565');
const custom = color.hex('#12abef').underline('Custom color');
```

Use `color` for chat strings that Pumpkin parses as section-sign color codes. Use `ansi` for
console output. Both formatters support the 16 legacy colors, named value roles, and the same
modifiers: bold, italic, underline, strikethrough, and obfuscated. The last color in a chain wins;
styled output ends with the appropriate reset code.

The `named` helpers give common values consistent colors, such as names, versions, numbers,
permissions, ports, UUIDs, identifiers, and errors. `color.hex()` emits Minecraft's RGB form;
`ansi.hex()` emits ANSI true color. Invalid hex input throws a `RangeError`. For richer chat styling,
use Pumpkin's native text components rather than encoding everything in a legacy string.
