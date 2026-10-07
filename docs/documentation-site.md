# Documentation site

The VitePress site combines the hand-written guides in `docs/`, component READMEs, component-level
guides, and TypeDoc output from exported TypeScript tools. Plugin, tool, and action pages appear in
separate navigation sections.

## Add a component guide

Create Markdown files under the component's `docs/` folder. For example, a plugin can have an
`index.md` plus additional pages such as `configuration.md`; tools and actions use the same layout.
The site discovers each file and adds it under that component's navigation. Relative links are
checked by `pnpm check`.

The component README serves as the overview when there is no custom `docs/index.md`. If a custom
index exists, it becomes the component landing page and the README remains available as a separate
**README** entry.

## API reference

TypeDoc reads exported symbols and JSDoc comments from the tool packages configured in
`typedoc.json`. Types and members without descriptions are omitted, keeping the generated reference
focused on documented APIs. Generated Pumpkin and WASI bindings can appear by name in public
signatures, but their generated declarations are not part of the reference. TypeDoc's check for
referenced, unexported types is disabled because it reports those generated bindings as missing.
Edit code comments at their source; do not edit generated API pages.

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
`pnpm run docs:build` is an alias for the complete production build.

The separate `.github/workflows/docs.yml` workflow checks docs on pull requests and publishes the
site from pushes to `master` or `main`. It deploys a GitHub Pages artifact and mirrors the built
files to the `gh-pages` branch. Configure the repository's Pages source to **GitHub Actions**.
