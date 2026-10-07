# Creating an action

```sh
pnpm gen:action
```

This runs the `action` Turborepo generator in `turbo/generators/`. It asks for the action's folder
name, display name and one-line description. To pass those answers directly:

```sh
pnpm gen:action --args my-action "My Action" "Does something useful"
```

The folder name uses kebab-case and must not exist under `actions/` already. The generator prompts
for all three values; the display name defaults to a title-cased folder name.

## What it creates

1. `actions/<folder>/action.yml`, a Node 24 JavaScript action that runs `src/index.mjs` without a
   compilation or bundling step.
2. `src/index.mjs` with a runnable placeholder, `src/index.test.mjs` with a co-located smoke test,
   and `src/utils.mjs`/`src/utils.test.mjs` with `getInput()` and `setOutput()`, plus regression tests
   for GitHub's input environment names and output-file format.
3. A `README.md`, `CHANGELOG.md` and `version.txt`, initialized to `0.0.0`. The README's Inputs and
   Outputs tables are generated from `action.yml`; actions with no declared values get an explicit
   “no inputs/outputs” note.
4. Entries in `release-please-config.json` and `.release-please-manifest.json`. The action's first
   release is pinned to `0.0.1`, and later releases get independent `<folder>-v<version>` tags.
5. A row in the Actions table in the root `README.md`.

The generator formats the files after creating them. It does not commit anything.

## Next steps

- Add inputs and outputs to `action.yml`. Read inputs with `getInput('input-name')` from
  `src/utils.mjs`; GitHub preserves hyphens in names such as `INPUT_PLUGIN-NAME`. See the warning in
  [CI and releases](ci-and-releases.md#registering-an-action-for-releases).
- Document input and output descriptions in `action.yml`. Do not edit the generated README tables
  directly; `pnpm readme` regenerates them and `pnpm readme:check` checks them for drift.
- Implement the action in `src/index.mjs` and cover its behavior in `src/*.test.mjs`. Action tests
  live beside their implementation and CI runs tests only for the changed action.
- Update the README's hand-written overview and usage examples, then run `pnpm readme` to generate
  its input/output tables and refresh the root action table.

Each action has an independent GitHub release and can be referenced by its subdirectory path. GitHub
does not automatically list action metadata files nested in a monorepo in the Marketplace; see
[CI and releases](ci-and-releases.md#registering-an-action-for-releases) for the release setup.
