# Documentation site

The VitePress site combines the hand-written guides in `docs/`, component READMEs, component-level
guides, and generated API references. Plugin, tool, and action pages appear in separate navigation
sections, and each component's navigation links to its reference.

## Add a component guide

Create Markdown files under the component's `docs/` folder. For example, a plugin can have an
`index.md` plus additional pages such as `configuration.md`; tools and actions use the same layout.
The site discovers each file and adds it to that component's sidebar and reference links. Relative
links are checked by `pnpm check`.

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
