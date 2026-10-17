# Contributing to `pumpkin-plugins`

These steps take you from setting up the repository to opening a pull request.

## Get set up

Use the Node version in [`.node-version`](https://github.com/filiphsps/pumpkin-plugins/blob/master/.node-version) and the pnpm version declared in [`package.json`](package.json) so your tools match the project. Then install the workspace:

```sh
pnpm install
```

If you're creating a plugin, action, or extension, use its generator: [`pnpm gen`](docs/creating-a-plugin.md), [`pnpm gen:action`](docs/creating-an-action.md), or [`pnpm gen:extension`](docs/creating-an-extension.md). For an existing component, start with the relevant guide in [`docs/`](https://github.com/filiphsps/pumpkin-plugins/blob/master/docs/README.md).

## Make and check your change

Follow the repository's [code style](docs/code-style.md). Keep unit tests beside the code. Put integration tests that need a real Pumpkin server in the package's `test/` directory; the [Testing guide](docs/testing.md) explains how to run them.

Update the docs and READMEs that describe your change. If you change generated README content, edit its source and run `pnpm readme`; then run `pnpm readme:check` to confirm the generated content is up to date.

Run the checks that cover the areas you changed:

- For code changes, run `pnpm lint`, `pnpm typecheck`, and `pnpm test`.
- For repository metadata and docs, run `pnpm check`.
- For plugin runtime changes, run the affected package's integration tests against a real Pumpkin server. The [Testing guide](docs/testing.md) gives you the scoped command.

## Open a pull request

Open your PR against the current `master` branch and keep it focused on one topic. Explain what changed and why, list the checks and scenarios you ran, and mention any checks you skipped or that failed. If you ran integration tests, include the Pumpkin version. The [pull request template](https://github.com/filiphsps/pumpkin-plugins/blob/master/.github/pull_request_template.md) has the full checklist.

Use Conventional Commit messages such as `feat:`, `fix:`, or `docs:`. Pull requests are rebase-merged, so each commit lands on `master` with its original message; see [CI and releases](docs/ci-and-releases.md#merging). The template's AI-assisted field is collected for analytics only, and you're responsible for everything in your PR.
