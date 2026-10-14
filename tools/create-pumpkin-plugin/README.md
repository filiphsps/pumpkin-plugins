# create-pumpkin-plugin

[![npm downloads](https://img.shields.io/npm/d18m/create-pumpkin-plugin?label=downloads%20%2818m%29)](https://www.npmjs.com/package/create-pumpkin-plugin)
[![latest npm release](https://img.shields.io/npm/v/create-pumpkin-plugin?label=latest%20release)](https://www.npmjs.com/package/create-pumpkin-plugin)
[![npm license](https://img.shields.io/npm/l/create-pumpkin-plugin)](https://www.npmjs.com/package/create-pumpkin-plugin)

Create a minimal standalone Pumpkin plugin in TypeScript or JavaScript. The CLI requires Node.js `24.21.0` or newer.

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

These launch forms follow the official [pnpm create](https://pnpm.io/cli/create), [npm init](https://docs.npmjs.com/cli/v11/commands/npm-init/), [Yarn Classic create](https://classic.yarnpkg.com/en/docs/cli/create/), [Yarn Modern CLI migration guide](https://yarnpkg.com/migration/guide#cli-changes), and [Bun create](https://bun.sh/docs/runtime/templating/create) references. The repository's packed-consumer CI contract validates pnpm only; the other rows document invocation syntax.

Add `--skip-install` to create the files without installing packages. Existing destinations are rejected and left untouched. Templates depend on `@pumpkin-plugins/pumpkin-api` and `@pumpkin-plugins/build`; they do not include the monorepo's `plugin-kit` scaffold.

The TypeScript template uses `src/plugin.ts`. The JavaScript template uses `src/plugin.js`, JSDoc types and `checkJs`. Both generate guest declarations from the API package's WIT using `pumpkin-plugins-build --types-only` before typechecking.

## Node.js and package manager support

The generator uses Node.js type stripping and requires Node `24.21.0` or newer. It runs the package manager entrypoint that launched it when installing dependencies; otherwise use the commands it prints after creation. The packed-consumer CI matrix targets pnpm `12.11.2` on Linux x64, macOS arm64 and Windows x64.

## API and ABI versions

The templates start with package version `0.1.0` and Pumpkin plugin WIT ABI `0.1.0`. These versions are separate. Keep the API package and Pumpkin server ABI aligned when upgrading.

<!-- docs:begin reference -->
<!-- docs:end reference -->
