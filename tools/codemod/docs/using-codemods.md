# Using codemods

`@pumpkin-plugins/codemod` provides named, repeatable migrations for Pumpkin plugin projects. The
CLI previews changes by default. It writes files only when you pass `--write`. The package requires
Node.js `24.21.0` or newer.

## Run a migration

After the first public npm release, list the available migrations from your plugin directory:

```sh
pnpm dlx @pumpkin-plugins/codemod list
```

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
  `dependencies`. For either package without an existing range, the codemod adds it at `^0.1.0`.
- A recognized `pumpkin-plugin-build <entry> <output>` command to
  `pumpkin-plugins-build`, moving the two paths into `pumpkinPlugin.entry` and
  `pumpkinPlugin.output`.
- Missing `pumpkinPlugin.engine` and `pumpkinPlugin.wasi` settings to `quickjs` and `[]` when it can
  infer the builder paths or update an object-valued `pumpkinPlugin` config. This keeps the runtime
  engine stable and initializes the capabilities list for manual review; existing values are kept.
- `scripts.typecheck` as `pumpkin-plugins-build --types-only && tsc --noEmit` when the codemod has
  both builder paths and the field is missing or exactly `tsc --noEmit`.
- `build/types/bindings/**/*.d.ts` in an explicit `tsconfig.json` `include` array.

The source transform changes parsed module specifiers only; it leaves comments, examples and other
string values alone. Existing custom build and typecheck commands are kept and reported for manual
review. The build command is recognized only as `pumpkin-plugin-build <entry> <output>` or
`pnpm exec pumpkin-plugin-build <entry> <output>`, with optional simple quotes around either path.
Flags, extra arguments, command chaining, shell variable expansions and other launchers are left for
manual review. The codemod does not update lockfiles or run package manager commands.

## Review and finish the migration

Review every file and note in the preview. After applying the codemod, inspect the diff:

```sh
git diff
```

Then complete the project-specific steps:

1. Run your package manager's install command to refresh the lockfile.
2. Check `pumpkinPlugin.wasi` and add the WASI capabilities the plugin uses. Use the
   [capability reference](../../../docs/creating-a-plugin.md#files-and-network-access) to identify
   capability names and related permissions. The codemod initializes a missing list as `[]`; it
   cannot determine capability use from arbitrary plugin code.
3. Confirm `tsconfig.json` includes the generated declaration glob if it has an explicit `include`
   list. If there is no explicit list, TypeScript uses its default file inclusion.
4. Run the project's typecheck, build and tests.
5. Review the migration guide's behavior and license notes, including diagnostics, IPC rejections,
   callback cleanup and runtime tick validation.

If the codemod reports that it cannot infer builder paths, configure `pumpkinPlugin.entry` and
`pumpkinPlugin.output`, then update the build command yourself. Do not replace a custom command until
you have confirmed its additional steps are preserved.
