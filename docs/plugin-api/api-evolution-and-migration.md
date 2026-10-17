---
navigation:
    category: Plugin API
title: "Plugin API: evolution and migration"
description: "Compatibility decisions, migration and SemVer policy"
---

# API evolution and migration

If your plugin uses `@pumpkinmc/pumpkin-api-ts`, use the [migration guide](../../tools/pumpkin-api/docs/migration.md) for the package and build changes. This page explains what the compatibility audit covers and how the API's version numbers signal changes.

## What the compatibility audit covers

The `v0.1.1` API from `@pumpkinmc/pumpkin-api-ts` is the compatibility baseline. The [compatibility inventory](../../tools/pumpkin-api/compatibility/v0.1.1.json) records a decision for every runtime export, public TypeScript type, WIT declaration and operation. Check it when you need to know whether a specific part of the old API is preserved.

The new facade also changes a few runtime behaviors:

- Missing command-suggestion handlers now report the requested handler ID.
- IPC rejection paths now throw descriptive `Error` objects.
- The facade releases event, command, suggestion, AI-goal and chunk-generator callbacks after `onUnload()`, even if the hook throws. It also removes event and command callbacks when host registration fails.
- Scheduled task helpers reject runtime tick values that aren't numbers or bigints.

The [migration guide](../../tools/pumpkin-api/docs/migration.md) explains what these changes mean for your plugin, including which old error assertions to update and when callbacks need to be registered again.

## Package and build changes

Move to `@pumpkin-plugins/pumpkin-api` for the runtime API and `@pumpkin-plugins/build` for the `pumpkin-plugins-build` command, which builds components and generates types. The old package and build command aren't included as compatibility shims. For a large existing plugin, the migration guide shows how to use a temporary pnpm dependency alias to avoid renaming every import at once.

## Versioning

While this package is below `1.0.0`, fixes and features use patch releases; breaking changes use the next minor release. For example, a breaking change from `0.1.0` becomes `0.2.0`. Once the package reaches `1.0.0`, it follows normal SemVer: fixes use patch versions, features use minor versions, and breaking changes require a major version.

Mark breaking commits with a Conventional Commit `!` marker, such as `feat!:` or a `BREAKING CHANGE` footer. Include release notes and migration steps so plugin authors can understand what changed and how to update.
