# Contributing to `pumpkin-plugins`

## Set up

Use the Node version in [`.node-version`](https://github.com/filiphsps/pumpkin-plugins/blob/master/.node-version) and the pnpm version declared in [`package.json`](package.json), then install the workspace:

```sh
pnpm install
```

Create new components with their generators: [`pnpm gen`](docs/creating-a-plugin.md), [`pnpm gen:action`](docs/creating-an-action.md), or [`pnpm gen:extension`](docs/creating-an-extension.md). For existing components, start with the relevant guide in [`docs/`](https://github.com/filiphsps/pumpkin-plugins/blob/master/docs/README.md).

## Make and verify a change

Follow [Code style](docs/code-style.md). Keep unit tests beside the code and integration tests against a real Pumpkin server under the package's `test/` directory; see [Testing](docs/testing.md).

Update docs and READMEs that describe the change. For generated README content, edit its source and run `pnpm readme`; run `pnpm readme:check` to check for drift.

Run the checks that cover your change:

- Code: `pnpm lint`, `pnpm typecheck`, and `pnpm test`.
- Repository metadata and docs: `pnpm check`.
- Plugin runtime behavior: run the affected package's integration tests against a real Pumpkin server. [Testing](docs/testing.md) has the scoped command.

## Open a pull request

Base the PR on the current `master` branch and keep it to one topic. Describe what changed and why, list the checks and scenarios you ran, and explain any checks you skipped or that failed. Include the Pumpkin version for integration tests. The [pull request template](https://github.com/filiphsps/pumpkin-plugins/blob/master/.github/pull_request_template.md) has the full checklist.

Use Conventional Commit messages such as `feat:`, `fix:`, or `docs:`. PRs are rebase-merged, so each commit lands as written; see [CI and releases](docs/ci-and-releases.md#merging). The template's AI-assisted field is for analytics, and the PR author remains responsible for its contents.
