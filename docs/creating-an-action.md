---
navigation:
    category: Getting started
title: "Creating an action"
description: "Create, document, test, and release a GitHub Action in this repository"
---

# Creating an action

Use the generator to create a GitHub Action scaffold and register it for releases:

```sh
pnpm gen:action
```

The generator asks for a folder name, display name, and one-line description. Use a new kebab-case
folder name under `actions/`; the display name defaults to the folder name with spaces and the
first letter of each part capitalized. You can provide all three answers in one command:

```sh
pnpm gen:action --args my-action "My Action" "Does something useful"
```

## What the generator sets up

Inside `actions/<folder>/`, the generator creates `action.yml` for a JavaScript action that runs
`src/index.mjs` on GitHub's Node 24 runtime. It also adds a runnable placeholder and smoke test in
`src/index.mjs` and `src/index.test.mjs`. There is no separate compilation or bundling step.

It also creates a README, `CHANGELOG.md`, and `version.txt`. The README contains generated input and
output tables based on `action.yml`; when the action has no inputs or outputs, it says so explicitly.
The generator registers the action in Release Please's configuration and manifest, and adds it to
the Actions table in the root README. It formats the scaffold and release files, but does not commit
them.

Each action has its own release history. The generator pins its first Release Please release to
`0.0.1`, while the initial manifest and `version.txt` start at `0.0.0`. Release tags use the action
folder name, such as `my-action-v0.0.1`; later action releases are independent of plugin and other
action releases.

## Finish the action

1. **Declare inputs and outputs** in `action.yml`, including descriptions that will make sense to
   someone configuring the action. The README tables are generated from this metadata, so don't edit
   those tables by hand.
2. **Read inputs and write outputs** with the shared `getInput()` and `setOutput()` helpers from
   `../../common/src/utils.mjs`. Pass the exact input name from `action.yml` to `getInput()`, such
   as `getInput('plugin-name')`. GitHub keeps hyphens in input environment variable names, so
   `plugin-name` becomes `INPUT_PLUGIN-NAME`, not `INPUT_PLUGIN_NAME`. See the warning in
   [CI and releases](ci-and-releases.md#registering-an-action-for-releases).
3. **Implement and test the behavior** in `src/index.mjs` and `src/*.test.mjs`. Tests live beside the
   implementation, and CI tests the actions selected by the changes in your pull request.
4. **Finish the README** with a human-written overview and usage examples. Then run `pnpm readme` to
   refresh the generated input/output tables, reference links, and root Actions table. Use
   `pnpm readme:check` to check for generated-documentation drift.

You can use the action by its folder path and action-specific release tag:

```yaml
steps:
  - uses: filiphsps/pumpkin-plugins/actions/my-action@my-action-v0.0.1
```

GitHub does not automatically list action metadata files nested inside a monorepo in the Marketplace.
For the release setup and other publishing details, see [CI and releases](ci-and-releases.md#registering-an-action-for-releases).
