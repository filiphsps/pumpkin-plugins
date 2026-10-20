---
title: "Using codemods"
description: "Run the Pumpkin API migration, preview changes, and finish the manual review"
navigation:
    category: Codemods
    catalog: true
---

# Using codemods

`@pumpkin-plugins/codemod` provides named, repeatable migrations for Pumpkin plugin projects. The
CLI previews changes by default. It writes files only when you pass `--write`.

## Requirements

<!-- docs:begin node-requirement -->
<!-- Generated from package.json and the registered codemods. Run `pnpm readme`. -->

Requires Node.js `>=24.21.0`.
<!-- docs:end node-requirement -->

## Available codemods

<!-- docs:begin available-codemods -->
<!-- Generated from package.json and the registered codemods. Run `pnpm readme`. -->

| Codemod | Description |
| --- | --- |
| `migrate-pumpkin-api-ts` | Migrate a plugin from @pumpkinmc/pumpkin-api-ts to @pumpkin-plugins/pumpkin-api. |
| `update-build` | Update @pumpkin-plugins/build and apply its release migrations. |
<!-- docs:end available-codemods -->

## Run a migration

List the available migrations from your plugin directory:

```sh
pnpm dlx @pumpkin-plugins/codemod list
```

Install the plugin's dependencies before updating its builder version. From the plugin root, preview
the latest published builder update and its release-specific migrations:

```sh
pnpm dlx @pumpkin-plugins/codemod update-build .
```

The command resolves the builder version installed for each package it scans, from that package's
directory, and fetches npm's current `latest` version without using a cached result. For each file
it applies only migrations introduced after the version installed for its package and no later
than the target release, in release order. Preview is the default;
apply the result with `--write`:

```sh
pnpm dlx @pumpkin-plugins/codemod update-build . --write
```

Supported exact, caret and tilde builder ranges keep their range style. Catalog, workspace, npm
alias, URL, file, git and composite ranges remain unchanged with a manual update note. The codemod
does not add a direct builder dependency when one is absent; if no scanned `package.json` declares
the builder, the preview says so once. Review the preview and run your package
manager after applying changes to refresh the lockfile.

Preview the Pumpkin API migration:

```sh
pnpm dlx @pumpkin-plugins/codemod migrate-pumpkin-api-ts .
```

The command reports changed files and review notes without writing. To apply the same changes:

```sh
pnpm dlx @pumpkin-plugins/codemod migrate-pumpkin-api-ts . --write
```

Write mode replaces each file atomically. A run that fails partway is not a multi-file transaction;
the error names files already updated so you can review them before rerunning.

You can pass one or more files or directories instead of `.`. The CLI searches directories
recursively, skipping child directories named `.git`, `.cache`, `.turbo`, `build`, `coverage`,
`dist`, or `node_modules`. An explicitly supplied directory is scanned even if its name is on that
list. Only regular files are scanned; symlinked files and directories are ignored. Start in the
plugin directory you intend to migrate when working in a monorepo. For a complete migration, scan
the plugin root: narrower inputs intentionally skip project files outside those paths and can leave
the migration incomplete.

Use `--print` to print the full transformed contents of each changed file. It does not write by
itself; combine it with `--write` only when you also want the files changed on disk.

## What the Pumpkin API migration changes

The `migrate-pumpkin-api-ts` codemod follows the repository's
[API migration guide](../../pumpkin-api/docs/migration.md). It updates:

- JavaScript and TypeScript imports, exports, import types, dynamic imports and `require()` calls
  from `@pumpkinmc/pumpkin-api-ts` to `@pumpkin-plugins/pumpkin-api`.
- `package.json` dependencies, replacing the old API package with `@pumpkin-plugins/pumpkin-api`
  and adding `@pumpkin-plugins/build` under `dependencies`. The old package is removed from
  `dependencies`, `devDependencies`, `peerDependencies`, or `optionalDependencies` wherever it is
  declared; each existing version range for the replacement packages is retained and moved into
  `dependencies`. For either package without an existing range, the codemod adds a caret range on
  its current release.
- A recognized `pumpkin-plugin-build <entry> <output>` command to
  `pumpkin-plugins-build`, moving the two paths into `pumpkinPlugin.entry` and
  `pumpkinPlugin.output`.
- A missing `pumpkinPlugin.engine` to `static-hermes`, the new builder's default runtime. The old
  builder ran QuickJS, so this changes the runtime and the preview adds a review note. Set `engine`
  to `quickjs` to keep the old runtime. An existing `engine` is preserved.
- A missing `pumpkinPlugin.wasi` to the capabilities the codemod can infer from the production
  entry, which keeps capabilities aligned with reachable WASI imports. An existing `wasi` array
  keeps its entries, and the codemod appends inferred capabilities that are missing from it. If
  entry inference is skipped, the current `wasi` value stays unchanged and the preview explains why.
- `scripts.typecheck` as `pumpkin-plugins-build --types-only && tsc --noEmit` when the codemod has
  both builder paths and the field is missing or exactly `tsc --noEmit`.
- `build/types/bindings/**/*.d.ts` in an explicit `tsconfig.json` `include` array. If the project
  inherits a restrictive include, it copies the effective patterns into the local config before
  adding the generated declarations. If there is no effective include but a local or inherited
  `files` list, it adds only the generated declaration glob and preserves the existing file roots.
  If an effective `exclude` pattern or `compilerOptions.outDir` omits those declarations, it leaves
  the config unchanged and reports a manual review note rather than changing the project's file
  roots. If it cannot resolve the extended config, it also reports a manual review note.

The codemod reads `package.json` as strict JSON, as npm and pnpm do. A manifest with comments or
trailing commas is left unchanged with a review note.

The source transform changes parsed module specifiers only; it leaves comments, examples and other
string values alone. If another string still names the old package, such as a `vi.mock()` or
`jest.mock()` argument, the preview adds a review note so you can update it by hand. Existing custom build and typecheck commands are kept and reported for manual
review. The build command is recognized only as `pumpkin-plugin-build <entry> <output>` or
`pnpm exec pumpkin-plugin-build <entry> <output>`, with optional simple quotes around either path.
Flags, extra arguments, command chaining, shell variable expansions and other launchers are left for
manual review. A string `pumpkinPlugin.entry` takes precedence over a parsed legacy entry; when both
are set and differ, the preview reports the mismatch and analyzes the configured entry.

Capability inference follows only the selected production entry and its reachable modules. It
includes runtime and type-only imports, re-exports, and statically resolvable literal `require()` and
`import()` calls, including transitive package dependencies. It does not execute project code or
start from tests and unrelated source files. The migration adds a capability only when the
builder's interface mapping identifies one capability unambiguously. Unresolved or computed imports,
shared interfaces, and support interfaces produce review notes without guessed capabilities; other
confident findings are still merged. If no configured or supported legacy entry resolves, inference
is skipped and the existing `wasi` value is preserved. The codemod does not update lockfiles or run
package manager commands.

## Review and finish the migration

Review every file and note in the preview. After applying the codemod, inspect the diff:

```sh
git diff
```

Then complete the project-specific steps:

1. Run your package manager's install command to refresh the lockfile.
2. Review `pumpkinPlugin.wasi` and the preview's inference notes. The codemod follows the selected
   production entry and reachable imports, but computed or unresolved imports and interfaces without
   a unique capability mapping still need manual review. Use the
   [capability reference](../../../docs/creating-a-plugin.md#files-and-network-access) to identify
   capability names and related permissions.
3. Confirm `tsconfig.json` includes the generated declaration glob. When there is no effective
   `include`, a local or inherited `files` list stays in place and only generated declarations are
   added. If neither `include` nor `files` is defined, TypeScript uses its default file inclusion.
   Check the codemod's manual review note if `exclude` or `compilerOptions.outDir` covers `build`.
4. Run the project's typecheck, build and tests.
5. Review the migration guide's behavior and license notes, including diagnostics, IPC rejections,
   callback cleanup and runtime tick validation.

If the codemod reports that it cannot infer builder paths, configure `pumpkinPlugin.entry` and
`pumpkinPlugin.output`, then update the build command yourself. Do not replace a custom command until
you have confirmed its additional steps are preserved.
