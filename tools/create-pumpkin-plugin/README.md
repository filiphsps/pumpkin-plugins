# create-pumpkin-plugin

[![npm downloads](https://img.shields.io/npm/dt/create-pumpkin-plugin)](https://www.npmjs.com/package/create-pumpkin-plugin)
[![latest npm release](https://img.shields.io/npm/v/create-pumpkin-plugin?label=latest%20release)](https://www.npmjs.com/package/create-pumpkin-plugin)
[![npm license](https://img.shields.io/npm/l/create-pumpkin-plugin)](https://www.npmjs.com/package/create-pumpkin-plugin)

Create a minimal standalone Pumpkin plugin in TypeScript or JavaScript.

```sh
pnpm create pumpkin-plugin my-plugin
```

In a terminal, the command prompts for TypeScript or JavaScript. Use a language flag for scripts and CI:

| Package manager | Interactive | TypeScript | JavaScript |
| --- | --- | --- | --- |
| pnpm | `pnpm create pumpkin-plugin my-plugin` | `pnpm create pumpkin-plugin my-plugin --ts` | `pnpm create pumpkin-plugin my-plugin --js` |
| npm | `npm create pumpkin-plugin my-plugin` | `npm create pumpkin-plugin my-plugin -- --ts` | `npm create pumpkin-plugin my-plugin -- --js` |
| Yarn Classic | `yarn create pumpkin-plugin my-plugin` | `yarn create pumpkin-plugin my-plugin --ts` | `yarn create pumpkin-plugin my-plugin --js` |
| Yarn Modern | `yarn dlx create-pumpkin-plugin my-plugin` | `yarn dlx create-pumpkin-plugin my-plugin --ts` | `yarn dlx create-pumpkin-plugin my-plugin --js` |
| Bun | `bun create pumpkin-plugin my-plugin` | `bun create pumpkin-plugin my-plugin --ts` | `bun create pumpkin-plugin my-plugin --js` |

These launch forms follow the official [pnpm create](https://pnpm.io/cli/create), [npm init](https://docs.npmjs.com/cli/v11/commands/npm-init/), [Yarn Classic create](https://classic.yarnpkg.com/en/docs/cli/create/), [Yarn Modern CLI migration guide](https://yarnpkg.com/migration/guide#cli-changes), and [Bun create](https://bun.sh/docs/runtime/templating/create) references.

Add `--skip-install` to create the files without installing packages. Existing destinations are rejected and left untouched. When launched by a supported package manager, the creator uses it to install dependencies. If it cannot detect one, it prints pnpm commands. Generated projects do not include the monorepo's `plugin-kit` scaffold.

The generated README uses the same package manager in its commands. Projects get a `pnpm-workspace.yaml`, which lets pnpm run esbuild's install script, only when the creator was launched by pnpm or could not detect a package manager.

The TypeScript template uses `src/plugin.ts`. The JavaScript template uses `src/plugin.js`, JSDoc types and `checkJs`. Both generate guest declarations from the API package's WIT using `pumpkin-plugins-build --types-only` before typechecking.

## Node.js and CI support

<!-- docs:begin support-contract -->
<!-- Generated from the creator and template manifests, .node-version, and .github/workflows/external-consumer.yml. Run `pnpm --filter create-pumpkin-plugin readme`. -->

| Contract | Value |
| --- | --- |
| Node.js minimum (creator CLI, JavaScript starter, TypeScript starter) | `>=24.21.0` |
| CI Node.js pin | `24.21.0` |
| Packed-consumer package manager | `pnpm` `12.11.2` |
| Linux x64 runner | `ubuntu-26.04` |
| macOS arm64 runner | `macos-15` |
| Windows x64 runner | `windows-2025` |
<!-- docs:end support-contract -->

## Starter package defaults

<!-- docs:begin template-defaults -->
<!-- Generated from templates/*/package.json and each starter entry point. Run `pnpm --filter create-pumpkin-plugin readme`. -->

| Starter | Package version | Package dependencies | Host WIT imports |
| --- | --- | --- | --- |
| JavaScript | `0.1.0` | `@pumpkin-plugins/build@^0.1.5`, `@pumpkin-plugins/pumpkin-api@^0.1.0` | `pumpkin:plugin/metadata@0.1.0` |
| TypeScript | `0.1.0` | `@pumpkin-plugins/build@^0.1.5`, `@pumpkin-plugins/pumpkin-api@^0.1.0` | `pumpkin:plugin/metadata@0.1.0` |
<!-- docs:end template-defaults -->

The npm package dependency range and host WIT interface version identify separate compatibility layers. See the [ABI and runtime guide](../../docs/plugin-api/abi-and-runtime.md) for compatibility with Pumpkin server releases.

<!-- docs:begin reference -->
<!-- docs:end reference -->
