---
title: "Adding codemods"
description: "Add, register, test, and package a Pumpkin codemod"
navigation:
    category: Codemods
    catalog: true
---

# Adding codemods

Codemods in `@pumpkin-plugins/codemod` follow a small per-file contract: each one selects the paths
it understands, transforms a file's text, and can return notes for the person reviewing the result.
Paths are relative to the directory where the runner starts.

## Add a migration

1. Add tests for the expected changes and failure cases in `src/codemods/<name>.test.ts`.
2. Implement the transform in `src/codemods/<name>.ts` using `CodemodDefinition` from `src/types.ts`.
3. Register it in `src/codemods/index.ts`. The CLI list and generated documentation catalog use this registry.
4. When users can run the migration, add its usage and review guidance to the end-user guide.

A transform has this shape:

```ts
import type { CodemodDefinition } from '../types.js';

export const renameOldPackage: CodemodDefinition = {
    id: 'rename-old-package',
    description: 'Rename a marker at the start of a plain-text line.',
    matchesFile: (relativePath) => relativePath.endsWith('.txt'),
    transform: ({ source }) => ({ source: source.replace(/^old-/gm, 'new-') }),
};
```

This example is for plain-text files where `old-` at the start of a line is the intended marker.
Raw replacements can also alter comments and string values in source code; use syntax-aware matching
for JavaScript and TypeScript.

Builder-release migrations go in `src/codemods/build-migrations.ts`. Each entry names the first
published builder version that requires the consumer change. Add an entry only when you have
verified that release needs it, and test both the change and repeat-run idempotence. The
`update-build` workflow selects migrations newer than the builder installed for each file's package
and no newer than the latest version fetched from npm, then applies them in version order. Leave the
registry empty until a published release requires a migration; don't add placeholders.

The ID becomes a CLI argument, so keep it unique and stable. `matchesFile` receives a slash-separated
path relative to the runner's working directory—the directory where the CLI was invoked. A source
file therefore has a plugin-relative path when you invoke the CLI from that plugin, and a
repository-relative path when you invoke it from the monorepo root. Return the original text when
there's nothing to change; the runner treats identical output as unchanged.

## Preserve source and make the transform safe to repeat

For JavaScript and TypeScript, prefer syntax-aware matching. When you need to preserve formatting,
comments, and unrelated text, use AST source spans to replace only the relevant part. The Pumpkin
API migration parses module specifiers with the TypeScript parser and edits `package.json` and
`tsconfig.json` with `jsonc-parser`. It reads `package.json` with `JSON.parse`, because package
managers reject comments and trailing commas there.

Preserve formatting, comments, unrelated settings, and custom commands. Only add dependencies or
configuration fields when the transform has enough information to give them valid values. If it
can't finish safely, leave the file unchanged and return a `messages` entry that explains what the
user needs to do manually. Test that a second run makes no further changes.

The runner finds regular files recursively. It skips child directories named `.git`, `.cache`,
`.turbo`, `build`, `coverage`, `dist`, or `node_modules`, but scans a directory you explicitly pass
even when its name is on that list. It ignores symlinks. Return review notes through
`TransformResult.messages`; the CLI prints each note with its file path.

## Test and build

From the repository root, run:

```sh
pnpm turbo run test --filter=@pumpkin-plugins/codemod
pnpm turbo run typecheck --filter=@pumpkin-plugins/codemod
pnpm turbo run build --filter=@pumpkin-plugins/codemod
```

To try your changes on a plugin before a release, run the built CLI from the repository root:

```sh
node tools/codemod/dist/bin/pumpkin-codemod.js list
node tools/codemod/dist/bin/pumpkin-codemod.js migrate-pumpkin-api-ts path/to/plugin
```

After changing the codemod registry or `engines.node`, regenerate the README and end-user guide with
`pnpm turbo run readme --filter=@pumpkin-plugins/codemod`. Their codemod catalog and Node.js
requirement come from the registry and `package.json`.

The package root exports `runCodemod`, the `CodemodDefinition` types, and the `codemods` registry.
The CLI accepts a codemod ID and optional paths; `--write` applies changes, and `--print` displays
the full transformed contents. Keep the end-user guide, tests, and package behavior in sync when
you change these contracts.

For changes to this public tool package, run `pnpm check` from the repository root to validate
release registration, package metadata, and documentation. Run `pnpm test:external-consumer` to
pack the tools, install them outside the workspace, and run `pumpkin-codemod list` to verify the
published CLI entry point. The supported Node and pnpm versions and CI workflow are documented in
[CI and releases](../../../docs/ci-and-releases.md).
