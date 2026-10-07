---
navigation:
    category: Getting started
---

# Documentation site

The VitePress site combines the hand-written guides in `docs/`, component READMEs, component-level
guides, and generated API references. The navigation groups items by category metadata stored with
their docs; names and descriptions still come from package manifests, action metadata, and guide
introductions. On phones, the same sections open as compact accordions in the navigation screen.

## Add a component guide

Create Markdown files under the component's `docs/` folder. For example, a plugin can have an
`index.md` plus additional pages such as `configuration.md`; tools and actions use the same layout.
The site discovers each file and adds it to that component's sidebar and reference links. Relative
links are checked by `pnpm check`.

For component-specific documentation settings, add a `docs.yml` file at the component root, next to
its `docs/` folder. Put navigation settings under `navigation`:

```yaml
navigation:
    category: Compatibility
    type: card
    icon: artwork/plugin-mark.svg
```

`category` is optional; without it, the item appears in its menu's general group. `type` is optional
and defaults to a regular link. Use `card` for a self-contained card or `spotlight` for a wide editorial
row. The `navigation` namespace keeps menu settings separate from other documentation settings that
may be added later. An icon path is relative to the component root, alongside `docs.yml`. Without an
explicit `icon`, the site automatically uses `icon.svg`, `icon.png`, `icon.webp`, `logo.svg`, `logo.png`, or
`logo.webp` from the component root when present, falling back to its `docs/` folder. Discovered icons
are included in the built site automatically and appear beside the title on the component's landing
page as well as in navigation. Items without artwork keep the same alignment.

Add a category to a hand-written guide's frontmatter with `navigation.category`; `navigation.type`
can also select `card` or `spotlight`. These categories are editorial labels and belong beside their
docs, not in a second list in the site configuration.

To feature a component in the desktop Plugins menu, add `navigation.featured: true` to the frontmatter
of its `docs/index.md`. It also remains a regular link in its category. A featured item defaults to
the card treatment, and can use `navigation.type: spotlight` to show as a wide row instead. The title
and description still come from the page heading and package manifest.

The component README serves as the overview when there is no custom `docs/index.md`. If a custom
index exists, it becomes the component landing page and the README remains available as a separate
**README** entry.

## Reference

The **Reference** section brings together documented exports from plugin and tool source, action
inputs and outputs from each `action.yml`, and exported repository script helpers. TypeDoc follows
the source folders discovered from package manifests; action contracts come directly from the action
metadata. Add JSDoc beside exported code and add action documentation to `action.yml` so the site
stays in sync without a second list of names or settings.

TypeDoc reads whole source trees, including implementation modules, so `excludeNotDocumented` keeps
symbols without JSDoc out of the reference. It is a presentation filter, not a completeness check;
the JSDoc lint enforces descriptions on exported TypeScript APIs.

Generated Pumpkin and WASI bindings can appear by name in public signatures, but their generated
declarations are not included as reference pages. The docs pipeline generates the needed bindings
before TypeDoc runs. Generated pages are build output and ignored by Git; edit source comments, action
metadata, or `typedoc.json` instead.

VitePress adds an **Edit this page on GitHub** link to Markdown pages. Generated API pages link that
action to the corresponding source file where TypeDoc can identify one.

The site shows **Last updated** using Git history. The docs workflow fetches full history so pages
that were not changed in the latest commit still show their latest edit time.

## Local commands

Run `pnpm run docs` to generate bindings and the API reference, then build the complete static site.
The two independent binding-generation steps run concurrently; TypeDoc and VitePress then run in
order because the site reads the generated API pages. Use `pnpm run dev:docs` to generate the same
inputs and start the VitePress development server, or `pnpm run docs:preview` to preview the last
built site.

The pipeline can also be run in stages: `pnpm run docs:types` generates the binding declarations,
`pnpm run docs:api` generates the TypeDoc reference after the bindings, and
`pnpm run docs:site` builds the VitePress site from those generated pages. The binding steps can be
run individually with `pnpm run docs:types:plugin-kit` or `pnpm run docs:types:update-check`.
Plugin guest declarations can be generated with `pnpm run docs:types:plugins`.
`pnpm run docs:build` is an alias for the complete production build.

The separate `.github/workflows/docs.yml` workflow checks docs on pull requests and publishes the
site from pushes to `master` or `main`. It deploys a GitHub Pages artifact and mirrors the built
files to the `gh-pages` branch. Configure the repository's Pages source to **GitHub Actions**.
