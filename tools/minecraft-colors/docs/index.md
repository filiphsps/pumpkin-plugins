# Minecraft colors

`@pumpkin-plugins/minecraft-colors` formats strings for Minecraft chat and terminal output, with no
runtime dependencies. Use `color` when Pumpkin will parse the string as legacy text, and use `ansi`
for console output.

```ts
import { ansi, color } from '@pumpkin-plugins/minecraft-colors';

const chat = color.gold.bold('Server restarting');
const consoleLine = ansi.named.port('25565');
const custom = color.hex('#12abef').underline('Custom color');
```

Both formatters support Minecraft's 16 legacy colors and the same modifiers: bold, italic,
underline, strikethrough, and obfuscated. Terminals have no obfuscated style, so `ansi` writes
obfuscated text without a code instead of hiding it. Chain a color and any modifiers in either
order, then call the result with the text to format. Modifiers accumulate; if you chain more than
one color, the last one takes effect. Formatted strings end with the reset code for their output
format, so following text won't inherit the style. You can nest one formatted string inside
another; the outer style resumes after the nested part ends.

The `named` helpers apply consistent colors to common values such as names, versions, numbers,
permissions, ports, UUIDs, identifiers, and errors. For a custom RGB color, pass six hexadecimal
digits to `color.hex()` or `ansi.hex()`; a leading `#` is optional. The first emits Minecraft's
section-sign RGB form, while the second emits ANSI true color. Invalid hex input throws a
`RangeError`. For richer chat styling, such as gradients or rainbow effects, use Pumpkin's native
text components.
