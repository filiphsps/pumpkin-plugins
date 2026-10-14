# @pumpkin-plugins/cspell-dict-minecraft

[![npm downloads](https://img.shields.io/npm/d18m/%40pumpkin-plugins%2Fcspell-dict-minecraft?label=downloads%20%2818m%29)](https://www.npmjs.com/package/@pumpkin-plugins/cspell-dict-minecraft)
[![latest npm release](https://img.shields.io/npm/v/%40pumpkin-plugins%2Fcspell-dict-minecraft?label=latest%20release)](https://www.npmjs.com/package/@pumpkin-plugins/cspell-dict-minecraft)
[![npm license](https://img.shields.io/npm/l/%40pumpkin-plugins%2Fcspell-dict-minecraft)](https://www.npmjs.com/package/@pumpkin-plugins/cspell-dict-minecraft)

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
