---
navigation:
    category: Plugin API
title: "Plugin API"
description: "Standalone API setup, lifecycle, host interfaces, ABI support and migration"
---

# Plugin API

Use `@pumpkin-plugins/pumpkin-api` as the runtime API in a standalone TypeScript plugin. Install it with the build tool:

```sh
pnpm add @pumpkin-plugins/pumpkin-api @pumpkin-plugins/build
```

Start with the guide that matches what you need to do:

- [Set up and build a plugin](setup-and-build.md): configure the package, generate WIT declarations
  and build the component.
- [Register lifecycle hooks and handlers](lifecycle-and-registration.md): implement startup and
  shutdown behavior and register callbacks.
- [Find a host operation](host-api.md): browse the Pumpkin WIT interface areas and understand how
  they differ from WASI capabilities.
- [Check ABI and runtime support](abi-and-runtime.md): match the host ABI to your Pumpkin server
  and check engine-specific limits.
- [Review compatibility or migrate](api-evolution-and-migration.md): understand API versioning and
  move from `@pumpkinmc/pumpkin-api-ts`.
- [Browse the generated API reference](/api/tools/@pumpkin-plugins/pumpkin-api/): look up exported
  symbols and their JSDoc.

The npm version of `@pumpkin-plugins/pumpkin-api` and the Pumpkin host ABI version are separate.
Check the [ABI and runtime guide](abi-and-runtime.md) when choosing a server release; generated
TypeScript declarations alone don't confirm that the server or selected engine supports an
operation.
