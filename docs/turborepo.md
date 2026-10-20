---
navigation:
    category: Plugin development
title: "Turborepo commands"
description: "The pnpm Turbo wrapper, log defaults, and flag overrides"
---

# Turborepo commands

Run Turbo tasks with the root `pnpm turbo` command. For `run` and `watch`, this wrapper uses the
repository's pinned Turbo CLI and adds these defaults unless you pass an explicit value:

| Flag | Default | Effect |
| --- | --- | --- |
| `--output-logs` | `new-only` | Show task output for cache misses |
| `--log-order` | `grouped` | Group output by task |
| `--log-prefix` | `none` | Do not add a prefix to log lines |

For example:

```sh
pnpm turbo run typecheck
pnpm turbo run test:integration --filter=@pumpkin-plugins/my-plugin
```

Replace `my-plugin` with the package's folder name.

Pass one or more flags to replace the matching defaults. Other defaults still apply:

```sh
pnpm turbo run test --output-logs=full
pnpm turbo run typecheck --log-order=stream --log-prefix=none
```

The root `pnpm build` and `pnpm dev` scripts also apply these defaults to their internal Turbo
commands. To override them, pass the flags after `--`, which forwards them through pnpm to the
script:

```sh
pnpm build -- --output-logs=full
pnpm dev -- --output-logs=errors-only
```

Use `pnpm turbo run` or `pnpm turbo watch` for direct Turbo task commands in scripts and CI that
should use these defaults.
