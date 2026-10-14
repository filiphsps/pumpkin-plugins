# @pumpkin-plugins/cspell-dict-minecraft

Minecraft terminology for [Code Spell Checker](https://marketplace.visualstudio.com/items?itemName=streetsidesoftware.code-spell-checker)
and the [`cspell`](https://www.npmjs.com/package/cspell) command-line linter. The dictionary covers
Minecraft terms and names, not PumpkinMC-specific terminology.

## Install

```sh
pnpm add -D @pumpkin-plugins/cspell-dict-minecraft
```

Add the package config to `cspell.config.yaml`:

```yaml
import:
  - '@pumpkin-plugins/cspell-dict-minecraft/cspell-ext.json'
```

The imported config defines and enables the `minecraft` dictionary.

## License

MIT. The word list is an independent collection of Minecraft terminology.
