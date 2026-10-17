---
navigation:
    category: Plugin API
title: "Plugin API: host API areas"
description: "What plugins can ask Pumpkin to do, and when they need WASI capabilities"
---

# Host API areas

Use the Pumpkin host API when your plugin needs to work with the running server. It covers plugin
setup, commands and events, server and game state, and Minecraft features such as inventories,
entities, text and scoreboards. The host interfaces come from the pinned `pumpkin:plugin@0.1.0` WIT
package. The build tool generates TypeScript declarations from that WIT, including its resources,
records, variants, enums and result types.

These interface groups are a useful place to start:

| If your plugin needs to... | Start with these interfaces |
| --- | --- |
| Set up and manage plugin context, metadata, permissions, logging or scheduled work | `context`, `metadata`, `permission`, `log`, `scheduler` |
| Register commands and listeners or send messages to other plugins | `command`, `event`, `game-events`, `ipc` |
| Read or change server state, players, worlds, entities, blocks, inventories or items | `server`, `player`, `world`, `entity`, `block-entity`, `inventory`, `item-stack`, `game-rules` |
| Work with Minecraft content and presentation, such as text, recipes, effects, scoreboards, forms or particles | `text`, `recipe`, `potions`, `status-effect`, `scoreboard`, `forms`, `particles` |
| Handle edition-specific protocol data | `java-packets`, `bedrock-packets` |

The [generated API reference](/api/tools/@pumpkin-plugins/pumpkin-api/) lists the exported TypeScript
symbols and signatures. The [lifecycle guide](lifecycle-and-registration.md) explains when to
register commands, listeners and other callbacks.

## When you need WASI

WASI is a separate set of system interfaces. Use it when your plugin needs HTTP, files or network
sockets; these are not Pumpkin host API operations. Declare the required capability names in the
`pumpkinPlugin.wasi` array in `package.json`:

| Capability | Provides |
| --- | --- |
| `http` | Outgoing HTTP requests |
| `filesystem` | Access to preopened directories |
| `sockets` | TCP sockets |
| `udp` | UDP sockets |

The builder adds the corresponding WASI 0.2.3 imports, along with shared clock, stream and polling
interfaces. The server must provide those imports, and the selected engine must support the
operations your plugin uses. See [Building](../building.md#runtime-caveats) for the engine-specific
limits and [Setup and build](setup-and-build.md) for the `package.json` configuration.
