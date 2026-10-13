---
navigation:
    category: Plugin API
---

# API evolution and migration

The v0.1.1 `@pumpkinmc/pumpkin-api-ts` API is the compatibility baseline. The [migration guide](../../tools/pumpkin-api/docs/migration.md) covers the package and build changes. The full [compatibility inventory](../../tools/pumpkin-api/compatibility/v0.1.1.json) records the decision for every export, type, WIT declaration and operation. Facade behavior changes include command-suggestion errors reporting the requested handler ID, IPC rejection paths throwing descriptive `Error` objects, callback cleanup after unload or failed registration, and rejecting task tick values other than numbers or bigints at runtime. The migration guide describes their impact.

Replace imports from `@pumpkinmc/pumpkin-api-ts` with `@pumpkin-plugins/pumpkin-api`, add the new package as a runtime dependency, and use `pumpkin-plugins-build` from `@pumpkin-plugins/build` to build components and generate types. No old package or build-command alias is provided.

Before `1.0.0`, compatible fixes use patch versions; features and breaking changes use the next minor version, so a breaking change from `0.1.0` becomes `0.2.0`. Starting at `1.0.0`, breaking changes require a major version. Breaking commits use a Conventional Commit `!` marker or `BREAKING CHANGE` footer and include release notes plus migration steps.
