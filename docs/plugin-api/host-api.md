---
navigation:
    category: Plugin API
---

# Host API areas

The pinned `pumpkin:plugin@0.1.0` WIT package groups host operations into interfaces for commands, events, server access, worlds, entities, inventory, networking, scheduling, IPC and metadata. WIT records, variants, enums, resources and result types are the source for generated TypeScript declarations.

Declare WASI capabilities separately through the `pumpkinPlugin.wasi` manifest field. The plugin API's Pumpkin host interfaces are not WASI imports. See [Building](../building.md#runtime-caveats) for the current engine-specific support notes and the [generated reference](/api/tools/@pumpkin-plugins/pumpkin-api/) for exported TypeScript symbols.
