---
title: "Adding codemods"
description: "Add, register, test, and package a Pumpkin codemod"
navigation:
    category: Codemods
    catalog: true
---

# Adding codemods

Codemods in `@pumpkin-plugins/codemod` use a small per-file contract. A codemod selects supported
paths relative to the runner's working directory, receives each file's original text, and returns
the transformed text with optional review notes.

## Add a migration

1. Write tests for the expected changes and failure cases in `src/codemods/<name>.test.ts`.
2. Add the transform in `src/codemods/<name>.ts` using `CodemodDefinition` from `src/types.ts`.
3. Register it in `src/codemods/index.ts`. The CLI list and generated documentation catalog read this registry.
4. Add migration-specific usage and review guidance to the user guide when it is ready for users.

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

Builder-release migrations are registered in `src/codemods/build-migrations.ts` with the first
published builder version that requires each change. Add an entry only for a verified consumer
change in that release, and add focused tests for its behavior and repeat-run idempotence. The
`update-build` workflow selects entries in semver order only when their release version is newer
than the installed builder and no newer than npm's target release. Keep the registry empty when no
published release requires a migration; do not add placeholders.

The ID becomes a CLI argument, so keep it unique and stable. `matchesFile` receives a slash-separated
path relative to the runner's current working directory, which is where the CLI was invoked. For
example, a source file is reported relative to the plugin directory when invoked there, or relative
to its repository path when invoked from the monorepo root. A transform should return the original
text when it has nothing to change. The runner treats identical output as unchanged.

## Preserve source and make the transform safe to repeat

Prefer syntax-aware matching for JavaScript and TypeScript. For text-preserving changes, use AST
source spans and replace only the relevant text. The Pumpkin API migration uses the TypeScript
parser for module specifiers and `jsonc-parser` edits for `package.json` and `tsconfig.json`.

Keep formatting, comments, unrelated settings and custom commands. Do not add dependencies or config
fields unless the transform has enough information to set valid values. When a transform cannot
finish safely, leave that file unchanged and return a `messages` entry explaining the manual step.
Test that a second run makes no further changes.

The runner discovers regular files recursively, skipping child directories named `.git`, `.cache`,
`.turbo`, `build`, `coverage`, `dist`, and `node_modules`. An explicitly supplied directory is
scanned even if its name is on that list. Symlinked files and directories are ignored. A transform
can return notes through `TransformResult.messages`; the CLI prints them beside the file path.

## Test and build

From the repository root, run:

```sh
pnpm turbo run test --filter=@pumpkin-plugins/codemod
pnpm turbo run typecheck --filter=@pumpkin-plugins/codemod
pnpm turbo run build --filter=@pumpkin-plugins/codemod
```

After changing the codemod registry or `engines.node`, regenerate the README and user guide with
`pnpm turbo run readme --filter=@pumpkin-plugins/codemod`. Their codemod catalog and Node.js
requirement are generated from the registry and `package.json`.

The package exposes `runCodemod`, the `CodemodDefinition` types and the bundled `codemods` registry
from its root entry point. The CLI accepts a codemod ID, paths, `--write` and `--print`. Keep the
end-user guide, tests and package behavior in sync when changing these contracts.

Public tool package changes also need `pnpm check` from the repository root to validate release
registration, package metadata and documentation. Run `pnpm test:external-consumer` to pack the
tools, install them outside the workspace and run `pumpkin-codemod list` to verify the published CLI
entry point. The supported Node and pnpm versions and CI workflow are documented in
[CI and releases](../../../docs/ci-and-releases.md).
