---
navigation:
    category: Plugin development
    type: spotlight
---

# Code style

`pnpm lint` runs two linters, and CI runs the same command.

## Biome

[Biome](https://biomejs.dev) formats and lints everything (`biome.json`). `pnpm lint:fix` applies
what it can fix. The [agent check runner](agent-tooling.md) checks changed files without applying
fixes, so it can safely inspect a working tree that contains other people's edits. Notable rules from
the config: single quotes, four-space indent, shorthand array types (`T[]`), `import type` for types, and a warning on `any`.

## JSDoc

Biome has no rule for documentation, so ESLint with `eslint-plugin-jsdoc` (`eslint.config.mjs`)
does that one job. It requires a JSDoc **description** on public code:

- exported functions, classes, interfaces, type aliases, enums and constants,
- public methods of exported classes.

It does not require `@param` and `@returns` tags, since TypeScript already types them. Add them
when they say something the signature doesn't, such as units, defaults or what a thrown error
means. If you write a `@param`, its name must match a real parameter, and tags don't take `{types}`.

Tests (including the `testing/` folders of shared packages), config files and generator templates are exempt, as are private helpers. A good description
says what the thing is for, not what its name says.

## Console log colors

Use `ansi.named` from [`@pumpkin-plugins/minecraft-colors`](../tools/minecraft-colors/README.md)
for values in console log messages. It applies terminal colors using the same named roles as
`color.named`, which formats Minecraft codes for chat replies. Keep the surrounding message plain
and do not add formatting codes directly at log call sites.

Keep this palette aligned with the Pumpkin server version pinned in
[`tools/test-harness/src/pumpkin-version.ts`](../tools/test-harness/src/pumpkin-version.ts). Pumpkin
uses cyan for plugin names, green for versions and bold yellow for permissions in its
[plugin permission prompt](https://github.com/Pumpkin-MC/Pumpkin/blob/0.2.0%2B26.3-26.51/crates/pumpkin/src/plugin/mod.rs#L493-L504).
Its [rolling log file layer](https://github.com/Pumpkin-MC/Pumpkin/blob/0.2.0%2B26.3-26.51/crates/pumpkin/src/logging.rs#L281-L335)
strips ANSI codes before writing saved logs. When the pinned server version changes, check both
source references and update the named roles if its palette or log handling changes.

## Structure

- Keep files small and focused. A file that does two things should be two files. Around 150 lines
  is a prompt to look for the seam, not a hard limit.
- Separate logic from the host. Pure logic (parsing, ordering, protocol state machines) goes in
  plain modules that take their dependencies as arguments. Code that touches Pumpkin or WASI is a
  thin adapter behind an interface, such as `DataFiles` or `Transport`. That keeps almost
  everything unit-testable and leaves only the adapters for the real-server tests.
- Group a plugin's `src/` by concern (`config/`, `packs/`, `web/`, `platform/`) rather than by
  kind of file.
- Share what more than one plugin needs through a package in `tools/`, as `@pumpkin-plugins/config`
  does, instead of copying it.

## Tests

- Unit tests (`*.test.ts`) sit beside the code. Real-server tests (`*.itest.ts`) live in `test/`,
  one file per concern. See [Testing](testing.md).
- Test behavior, including the failure paths: invalid input, missing files, clients that hang up.
  Don't assert things the types already guarantee.
- Generate fixtures in code (for example `.mcpack` archives) instead of committing binaries.

## Package metadata

Every `package.json` (the root, each plugin, each tool) carries the same author,
contributors, homepage, repository, bugs and funding fields, and a description of at most 70
characters. Tools that export code also set `sideEffects`, `module`, `types`, `files` and
`publishConfig`. `node scripts/package-metadata.mjs` checks it and `--fix` writes everything that can
be derived; `pnpm gen` already generates plugins that pass. The homepage of a package is its folder's
README on `master`. Packages use MIT by default. A package with its own `LICENSE`, `LICENSE.md`
or `LICENSE.txt` file keeps the license declared in its `package.json`, including when metadata
is fixed.

## Docs match the code

A change that makes a doc wrong is not finished until the doc is fixed, and the checks keep it honest:

- `pnpm readme:check` fails when generated README content is stale: plugin documentation, root
  action/package tables, or action input/output tables from `action.yml`.
- `pnpm check` runs `scripts/check-docs.mjs`, which fails when a README is missing from a package, a
  link, heading or repo path in the docs doesn't exist, a `pnpm` command isn't a script, a page isn't in
  the docs index, a root script isn't documented, or a CI job isn't in the CI table.
- Documentation that can be derived from code is derived: commands are declared once with
  `defineCommands` and listed in the README from the same declaration, permission names are typed
  against the ones Pumpkin knows, and settings come from the config schema.

What a script can't check is whether the prose is right. The pull request template asks for it, so
read the docs you touched, and the ones that describe what you changed (search `docs/` and the
READMEs for the names you renamed).
