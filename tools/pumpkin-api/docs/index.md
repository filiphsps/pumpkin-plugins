---
navigation:
    category: Plugin API
---

# Pumpkin Plugin API

Use `@pumpkin-plugins/pumpkin-api` when a standalone TypeScript plugin needs to call Pumpkin's host
API. The package's pinned WIT contract defines the host ABI your server must support; the npm
package version and host ABI version are separate, so check compatibility before choosing a server.

## Guides

- [Set up and build a plugin](../../../docs/plugin-api/setup-and-build.md) to configure the package,
  generate WIT declarations, and build a component.
- [Register lifecycle callbacks](../../../docs/plugin-api/lifecycle-and-registration.md) to handle
  startup, shutdown, and host callbacks.
- [Check ABI and runtime support](../../../docs/plugin-api/abi-and-runtime.md) to match the pinned
  host interface to your Pumpkin server and engine.
- Read about [API evolution and migration](../../../docs/plugin-api/api-evolution-and-migration.md),
  including the [guide for migrating from `@pumpkinmc/pumpkin-api-ts`](migration.md).

When you need a specific symbol or signature, look it up in the [generated API
reference](/api/tools/@pumpkin-plugins/pumpkin-api/).
