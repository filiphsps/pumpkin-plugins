---
navigation:
    category: Plugin development
    type: spotlight
title: "Code style"
description: "Biome, the JSDoc rule, and how code is organized and tested"
---

# Code style

Use this guide when you add or change code in the repository. Run `pnpm lint` to check your changes;
CI runs the same command. Biome handles formatting and general linting, while ESLint checks public
code for JSDoc descriptions.

## Formatting and linting

[Biome](https://biomejs.dev) formats and lints the files listed in `biome.json`. Run `pnpm lint:fix`
to apply automatic fixes; it also formats SVG files with Biome's HTML formatter. `pnpm lint` checks
without changing files. If you use the [agent check runner](agent-tooling.md), it checks only changed
files and does not apply fixes, so it can run safely while other local edits are present.

Follow the rules in `biome.json`: use single quotes, four spaces for indentation, shorthand array
types such as `T[]`, and `import type` for type-only imports. Explicit `any` is an error.

## JSDoc

Biome doesn't check documentation, so ESLint uses `eslint-plugin-jsdoc` in
[`eslint.config.mjs`](../eslint.config.mjs) to require a description for public code. Add a JSDoc
description to exported functions, classes, interfaces, type aliases, enums and constants, and to
public methods of exported classes. Explain what the code is for; don't just repeat its name.

TypeScript already provides parameter and return types, so you don't need `@param` or `@returns`
tags. Add them when they explain something the signature can't, such as units, defaults or what an
error means. If you add a `@param` tag, its name must match a real parameter. Don't include types in
JSDoc tags.

The rule skips tests (including `test/` and `testing/` directories), config files and the
`turbo/generators/templates/` tree. Private helpers don't need descriptions. It checks `.ts` source
across the repository and `.mts` and `.mjs` source in `tools/static-hermes-runtime`. Keep declaration
files aligned with their source API; this rule doesn't lint them.

## Color in console logs

Format values in console log messages with `ansi.named` from
[`@pumpkin-plugins/minecraft-colors`](../tools/minecraft-colors/README.md). Its terminal colors use
the same named roles as `color.named`, which formats Minecraft codes for chat replies. Leave the
surrounding message plain instead of adding formatting codes at the log call site.

<!-- These Pumpkin source links are generated from the test-harness pin. Run `pnpm readme`. -->
Keep this palette aligned with the Pumpkin server version pinned in
[`tools/test-harness/src/pumpkin-version.ts`](../tools/test-harness/src/pumpkin-version.ts). Pumpkin
uses cyan for plugin names, green for versions and bold yellow for permissions in its
[plugin permission prompt](https://github.com/Pumpkin-MC/Pumpkin/blob/0.2.0%2B26.3-26.51/crates/pumpkin/src/plugin/mod.rs).
Its [rolling log file layer](https://github.com/Pumpkin-MC/Pumpkin/blob/0.2.0%2B26.3-26.51/crates/pumpkin/src/logging.rs)
strips ANSI codes before writing saved logs. Review these sources when the pinned server changes;
update the named roles if its palette or log handling changes.

## Structure

Keep each file focused on one job. If a file starts doing two things, look for a useful seam and
split it; around 150 lines is a prompt to review the structure, not a hard limit.

Keep core logic separate from Pumpkin and WASI. Put logic such as parsing, ordering and protocol
state machines in plain modules, and pass their dependencies in. Put Pumpkin- or WASI-specific work
behind a thin adapter such as `DataFiles` or `Transport`. That keeps most code easy to unit test and
lets real-server tests focus on the boundary with Pumpkin and WASI.

Group a plugin's `src/` files by concern, such as `config/`, `packs/`, `web/` or `platform/`, rather
than by file type. When more than one plugin needs the same code, put it in a package under `tools/`
as `@pumpkin-plugins/config` does; don't copy it between plugins.

## Tests

The repository's [testing policy](https://github.com/filiphsps/pumpkin-plugins/blob/master/AGENTS.md#testing-policy)
decides which kind of test to write and when. Real-server tests (`*.itest.ts`) in `test/` get one
file per concern, and the [Testing guide](testing.md) covers how to run them.

Test behavior, including failure paths such as invalid input, missing files and clients that hang
up. There's no need to assert behavior that TypeScript's types already guarantee. Generate fixtures
in code, for example by building `.mcpack` archives in the test, instead of committing binary files.

## Package metadata

When you add or update a package, run `node scripts/package-metadata.mjs` to check its metadata. The
script checks the license, homepage, repository, bugs field and a description of at most 70 characters.
It derives workspace links from the root repository URL. Add `--fix` to write values that can be
derived; the script leaves descriptions and package-specific fields for you to maintain.

For public npm tools, set `engines.node` from `.node-version`. Tools that consumers import set
`sideEffects`. If a tool has a package-root entry, set top-level `module` and `types`; if it exposes
only subpath APIs, declare `types` and runtime conditions on each public entry in `exports`. Each
tool also owns its `files` and `publishConfig` settings.

`pnpm gen` creates plugins that pass these checks. A package's homepage points to its folder README
on `master`. Packages use MIT by default. If a package has its own `LICENSE`, `LICENSE.md` or
`LICENSE.txt` file, keep the license declared in its `package.json`; `--fix` preserves that value.

## Keep docs in sync with code

If a code change makes a doc inaccurate, update the doc before you finish. `pnpm fix` checks release
configuration, fixes derived package metadata, regenerates READMEs, checks documentation and ends
with `pnpm lint:fix`. You still need to correct release registration and errors in handwritten docs
yourself.

The documentation checks catch different kinds of drift:

- `pnpm readme:check` checks generated README content, including plugin docs, the root action and
  package tables, and action input and output tables generated from `action.yml`.
- `pnpm check` verifies release configuration and package metadata, then runs
  `scripts/check-docs.mjs`. That script checks for missing package READMEs, broken links, headings
  and repository paths, invalid `pnpm` commands, pages missing from the docs index, undocumented root
  scripts and CI jobs missing from the CI table.

Keep plugin documentation tied to the code that drives it. Declare commands once with
`defineCommands`, then use that tree for registration and README command rows; it also constrains
command permission nodes to the plugin name. `PluginInfo` checks requested permission names against
Pumpkin's `PumpkinPermission` type, including `sys.env.<NAME>`. Define settings in the config schema
and pass its `describeConfig` result to `info.config`, so defaults, validation and README settings
come from the same source. See [Plugin info and READMEs](plugin-info-and-readmes.md) and
[Plugin config](plugin-config.md) for these contracts.

Scripts can't tell whether prose still describes the behavior. Read the docs you touched and the
ones that explain your change. When you rename something, search `docs/` and the READMEs for the old
name; the pull request template also asks you to confirm that the prose is accurate.
