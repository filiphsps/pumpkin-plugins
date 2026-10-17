# Documentation generator

`@pumpkin-plugins/docs` defines plugin metadata and generates repository documentation from the
component sources. It reads plugin `src/info.ts`, command declarations, configuration schemas,
package manifests, component guide files, and GitHub Action metadata rather than maintaining a
separate component catalog.

## Regenerate repository docs

Run `pnpm readme` after changing plugin information, command declarations, config schemas, action
inputs or outputs, package metadata, or component guides. It updates generated README sections,
component guide and API reference links, and the root package and action tables.

Run `pnpm readme:check` to verify that generated files are current without writing them. Keep the
markers around generated README blocks in place. Change their source metadata or the Markdown
outside generated blocks instead of editing generated content by hand.

## Plugin metadata

Plugins declare their name, description, permissions, commands, compatibility notes, and config
description as typed `PluginInfo`. The same declarations feed Pumpkin metadata and generated
README tables, which helps keep runtime behavior and operator documentation aligned. Component
guides live next to the package in `docs/`; the site discovers those pages and their navigation
from the filesystem and component metadata.

## Generate custom component documents

Tools and other components can generate named blocks in any existing Markdown file. Declare the
blocks from the component's source metadata, then let this package handle marker validation, file
updates and drift checks. Keep the content renderer local to its component.

```ts
// docs.ts, in the component root
import type { DocumentSpec } from '@pumpkin-plugins/docs/node';
import { code, table } from '@pumpkin-plugins/docs/markdown';
import { LIMITS } from './src/protocol.ts';

export const documents = [{
    file: 'docs/index.md',
    blocks: {
        limits: table(['Limit', 'Maximum'], [
            ['Text', code(String(LIMITS.text))]
        ])
    },
    note: '<!-- Generated from src/protocol.ts. Run `pnpm readme`. -->'
}] satisfies DocumentSpec[];
```

Place the corresponding markers in the document:

```md
<!-- docs:begin limits -->
<!-- docs:end limits -->
```

Add `"readme": "pumpkin-plugins-docs generate docs.ts"` and
`"readme:check": "pumpkin-plugins-docs generate docs.ts --check"` to the component's package scripts.
Declare `@pumpkin-plugins/docs` as a `workspace:*` development dependency. The root `pnpm readme`
and `pnpm readme:check` commands then include it through Turborepo.

The module must export a `documents` array. Paths are relative to the working directory, even when
the module lives in a subdirectory. Node loads TypeScript modules by stripping types, so their
imports must work without Pumpkin/WASI and without TypeScript syntax requiring transformation.
The command defaults to `docs.ts` when its module argument is omitted.

Generation requires existing files and exactly one ordered marker pair for every declared block.
All targets are read and validated before any writes; duplicate targets, missing markers, duplicate
markers and reversed pairs are errors. `--check` reports stale content without writing. Filesystem
write failures can still leave earlier targets updated; this is validation before writes, not a
transaction. Everything outside the generated markers is preserved.

Each document accepts `note` (omitting it uses a generic generation note; an empty string omits it), `required: false` to allow absent blocks,
and `markers: 'action'` for existing `<!-- action-inputs:start -->` / `<!-- action-inputs:end -->`
markers. Plugin README generation retains its existing optional-block behavior.

## Reuse the generation helpers

| Entry point | Use |
| --- | --- |
| `@pumpkin-plugins/docs` | Host-safe plugin metadata, commands, `code` and `table` |
| `@pumpkin-plugins/docs/markdown` | Host-safe `cell`, `code`, `table`, generated-block readers and their types |
| `@pumpkin-plugins/docs/node` | Node-only `generateDocuments`, `DocumentSpec`, `Status`, component discovery and Markdown traversal |

`table(headers, rows)` escapes pipes in headers and values and folds multiline cells into one
line. Pass `{ multiline: 'break' }` to retain line breaks as `<br>`. `code(text)` chooses a backtick
fence that preserves embedded backticks and surrounding spaces. Pass unescaped text to the table
helper; it owns cell escaping.

`generateDocuments(documents, root, check?)` provides the same validation and write behavior as the
CLI and returns `updated`, `unchanged` or `stale`. `discoverComponents(root, group)` finds sorted
folders under `packages`, `tools`, `actions`, `extensions` or `native` that have group-specific
metadata, excluding underscore-prefixed scratch folders. Each result supplies `slug`, `directory`
and `metadataFile`; callers decide whether source files or READMEs are also required.
`walkMarkdown(directory, { exclude? })` finds sorted Markdown
files recursively, excluding `node_modules`, `.git` and explicit absolute paths.

Import Node helpers through the `/node` entry point, never from guest plugin code. Keep package
versions owned by release-please out of generated prose unless regeneration is part of that release
workflow. Protocol versions and pinned external fixtures can be generated from their own metadata.

## GitHub Action documentation

`pumpkin-plugins-docs actions` generates every action README's input/output sections from
`action.yml` or `action.yaml`. Run it from the repository root; add `--check` to check for drift.
The existing `action-inputs` and `action-outputs` markers remain supported, with the same strict
pair validation as custom documents. All action targets are validated before writing.

The `/node` entry point exports `readActionMetadata(file)`, `renderActionSections(metadata, options?)`
and `generateActionReadmes(root, check?)`. The README generator and API-reference builder use the
same action renderer, including required inputs, default values, descriptions and actions without
inputs or outputs. YAML parsing is shared with the repository catalog and site.

`githubRepositoryUrl(repository)` normalizes a GitHub package repository field;
`githubPagesUrl(repository)` derives its Pages base URL. `componentApiRoute(group, slug, packageName?)`
provides the API route used by README links, generated references and the site. Tool routes use the
package name; plugin and action routes use the folder slug.

The release workflow runs `pnpm exec pumpkin-plugins-docs action-versions` separately to refresh
example tags from `.release-please-manifest.json`. Unreleased actions use their `release-as` pin
from `release-please-config.json`. `--check` checks these values without changing files. This
command is intentionally separate from ordinary README regeneration because it follows release
metadata rather than action input/output contracts.

For generated values outside block markers, a document can supply `transform(source)` instead of
`blocks`. The transformation returns the complete next text and can throw when a required value is
missing. The shared generator still prepares every target before writing and supports drift checks.

`localLicenseFile(directory)` finds a local `LICENSE`, `LICENSE.md` or `LICENSE.txt` file,
case-insensitively, ignoring directories. Package metadata checks and generated catalogs use the
same rule. Repository scripts also reuse component discovery for release registration, bundled
package lookup, plugin collection, signed artifact installation and development builds.

`generatedBlocks(source)` finds complete blocks in both supported marker syntaxes, returning each
block's name, syntax, text and `[start, end)` source offsets. `stripGeneratedBlocks(source)` removes
those blocks while preserving handwritten content. These host-safe `/markdown` helpers are shared
by generation, Market descriptions and the agent edit guard. Extraction accepts spaced markers and
leaves incomplete pairs untouched; generation separately enforces its declared marker pairs.

The PumpkinPIE API's [document module](../../apis/pumpkin-pie-api/docs.ts) uses this CLI and the shared
Markdown helpers to render protocol facts and provider provenance from source metadata. It keeps
only its component-specific renderer and has no separate file updater or drift-check command.

This package is ESM. VitePress data loaders that import its Node API use `.data.mts` or `.data.mjs`
so VitePress's loader bundler treats those imports as ESM too.
