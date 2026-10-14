# Adding codemods

Codemods in `@pumpkin-plugins/codemod` use a small per-file contract. A codemod selects supported
paths relative to the runner's working directory, receives each file's original text, and returns
the transformed text with optional review notes.

## Add a migration

1. Write tests for the expected changes and failure cases in `src/codemods/<name>.test.ts`.
2. Add the transform in `src/codemods/<name>.ts` using `CodemodDefinition` from `src/types.ts`.
3. Register it in `src/codemods/index.ts`. The CLI list reads this registry.
4. Add an entry to the user guide if the migration is ready for users.

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
pnpm --filter @pumpkin-plugins/codemod test
pnpm --filter @pumpkin-plugins/codemod typecheck
pnpm --filter @pumpkin-plugins/codemod build
```

The package exposes `runCodemod`, the `CodemodDefinition` types and the bundled `codemods` registry
from its root entry point. The CLI accepts a codemod ID, paths, `--write` and `--print`. Keep the
end-user guide, tests and package behavior in sync when changing these contracts.

Public tool package changes also need `pnpm check` from the repository root to validate release
registration, package metadata and documentation. Run `pnpm test:external-consumer` to pack the
tools, install them outside the workspace and run `pumpkin-codemod list` to verify the published CLI
entry point. The supported Node and pnpm versions and CI workflow are documented in
[CI and releases](../../../docs/ci-and-releases.md).
