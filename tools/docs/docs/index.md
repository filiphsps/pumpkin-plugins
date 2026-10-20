# Documentation generator

`@pumpkin-plugins/docs` writes README blocks and catalogs from metadata the repository already has:
plugin `src/info.ts` files, command trees, config schemas, `package.json` manifests, `action.yml`
files and page frontmatter. Its `pumpkin-plugins-docs` command does the writing, and the root
`pnpm readme` runs every command this repository needs.

## Regenerate repository docs

Run `pnpm readme` after changing plugin information, command declarations, config schemas, action
inputs or outputs, package metadata, release pauses or guide pages. Run `pnpm readme:check` to see
whether generated content is current without writing anything.

Generated content sits between markers such as `<!-- docs:begin commands -->` and
`<!-- docs:end commands -->`. Keep the markers in place and edit the source metadata or the Markdown
outside them. The generator keeps everything outside the markers as you wrote it.

## Commands

Each command reads from the folder you run it in and writes only existing files. Add `--check` to any
command to report stale files without writing them; the command then exits with code 1 if something
is out of date.

| Command | Run from | Writes |
| --- | --- | --- |
| `plugin` (the default) | A plugin folder | The generated blocks of that plugin's `README.md` |
| `root` | The repository root | The action, plugin, tool and extension tables in `README.md`, and the `reference` block with guide and API links in each component README |
| `docs-index` | The repository root | The Guides and Docs catalog in `docs/README.md` |
| `generate [module]` | A component folder | The blocks a document module declares; the module defaults to `docs.ts` |
| `actions` | The repository root | The input and output tables in each action README |
| `action-versions` | The repository root | The example release tags in each action README |

The release workflow runs `action-versions` on its own because the tags follow
`.release-please-manifest.json`. An action that hasn't been released yet uses its `release-as` pin
from `release-please-config.json`.

Outside this repository, add the package as a development dependency and run the command with
`pnpm exec pumpkin-plugins-docs`. The published package is compiled JavaScript, so it runs on Node
without TypeScript tooling.

## What the commands find

The `root` and `actions` commands look for components in `packages/`, `tools/`, `actions/` and
`extensions/`. A folder is a component when it has a `package.json`, or an `action.yml` or
`action.yaml` for actions. A folder in `tools/` without a manifest groups related tools, so
`tools/apis/upnpumpkin-api` is a component of its own. Folders whose names start with `_` are
skipped, which leaves room for scratch work.

`docs-index` lists each direct child of `docs/` as a guide, grouped by its `navigation.category`
frontmatter. Pages in subfolders become the Docs tree, and a folder's `index.md` is its landing page.
It skips the `api` folder of `docs/`, which holds generated API pages, and `docs/agents/`, which
holds instructions for coding agents. A component guide appears in the catalog only when its frontmatter sets
`navigation.catalog: true`.

## Plugin READMEs

A plugin describes itself with a typed `PluginInfo`: its name, description, permissions, commands
and config file. Pumpkin's plugin metadata and the README tables come from the same object. The
`installation` block also reads `pumpkinPlugin.output` from `package.json`, and a plugin listed in
`release-please-paused.json` gets build steps and the pause reason instead of a download link. The
[plugin info and READMEs guide](../../../docs/plugin-info-and-readmes.md) covers each block.

## Generate custom component documents

Tools and other components can fill named blocks in any existing Markdown file. Write a document
module that renders the blocks from the component's own source, and let the CLI handle markers,
writes and drift checks.

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

Put the matching markers in the document:

```md
<!-- docs:begin limits -->
<!-- docs:end limits -->
```

Then add `"readme": "pumpkin-plugins-docs generate docs.ts"` and
`"readme:check": "pumpkin-plugins-docs generate docs.ts --check"` to the component's scripts, and
declare `@pumpkin-plugins/docs` as a `workspace:*` development dependency. The root `pnpm readme`
and `pnpm readme:check` pick the scripts up through Turborepo.

The module must export a `documents` array. File paths are relative to the folder you run the
command in, even when the module lives in a subfolder. Node loads a TypeScript module by stripping
its types, so the module and its imports can't need Pumpkin, WASI or TypeScript syntax that has to be
compiled.

Each target file must exist and contain exactly one ordered marker pair for every declared block. The
command reads and checks every target before it writes any of them, so a duplicate target or a
missing, repeated or reversed marker fails without changing files. A failed write can still leave
earlier files updated.

A document can also set:

- `note` to replace the generated comment at the top of each block, or `''` to leave it out.
- `required: false` to skip blocks the file has no markers for.
- `markers: 'action'` to use the `<!-- action-inputs:start -->` and `<!-- action-inputs:end -->`
  marker style of action READMEs.
- `transform(source)` instead of `blocks`, for values outside markers. It returns the whole new file
  and can throw when a required value is missing.

The PumpkinPIE API's [document module](../../apis/pumpkin-pie-api/docs.ts) is a working example.

## Reuse the generation helpers

| Entry point | Use |
| --- | --- |
| `@pumpkin-plugins/docs` | Plugin metadata, commands, `code` and `table`; safe to import from plugin code |
| `@pumpkin-plugins/docs/markdown` | `cell`, `code`, `table` and generated-block readers; safe to import from plugin code |
| `@pumpkin-plugins/docs/node` | File generation, drift checks, component and page discovery; Node only |

`table(headers, rows)` escapes pipes and folds multiline cells into one line. Pass
`{ multiline: 'break' }` to keep line breaks as `<br>`. `code(text)` picks a backtick fence that
keeps embedded backticks and surrounding spaces. Pass plain text to `table`, which escapes cells
itself.

`generatedBlocks(source)` returns each complete generated block with its name, marker style, text and
source offsets, and `stripGeneratedBlocks(source)` removes them while keeping hand-written content.
Market descriptions and the agent edit guard use these readers.

From `/node`, `generateDocuments(documents, root, check?)` runs the same checks and writes as the
`generate` command and returns `updated`, `unchanged` or `stale`. `discoverComponents(root, group)`
and `walkMarkdown(directory, { exclude? })` are the discovery rules described above, and
`discoverHandwrittenDocs(root)` and `buildDocumentationTree(pages)` build the docs catalog the site
also uses. `titleOf`, `descriptionOf` and `frontmatterOf` read page metadata the same way the catalog
does. Never import `/node` from plugin code.

This package is ESM. A VitePress data loader that imports `/node` needs the `.data.mts` or
`.data.mjs` extension so VitePress bundles it as ESM.
