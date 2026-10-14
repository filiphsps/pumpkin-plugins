---
navigation:
    category: Plugin development
---

# Turborepo commands

Run direct Turbo tasks through the root `pnpm turbo` command. It uses the repository's pinned Turbo
CLI and adds these defaults unless you pass an explicit value:

| Flag | Default | Effect |
| --- | --- | --- |
| `--output-logs` | `new-only` | Show task output for cache misses |
| `--log-order` | `grouped` | Group output by task |
| `--log-prefix` | `task` | Prefix log lines with the package and task names |

For example:

```sh
pnpm turbo run typecheck
pnpm turbo run test:integration --filter=@pumpkin-plugins/<folder>
```

Pass one or more flags to replace the matching defaults. Other defaults still apply:

```sh
pnpm turbo run test --output-logs=full
pnpm turbo run typecheck --log-order=stream --log-prefix=none
```

Root task scripts such as `pnpm typecheck`, `pnpm test`, `pnpm test:integration`, and `pnpm readme`
use this wrapper. The build and dev scripts also apply the same defaults to their internal Turbo
commands. Pass overrides through those scripts after `--`:

The `--` separator forwards the following options through pnpm to the script.

```sh
pnpm build -- --output-logs=full
pnpm dev -- --output-logs=errors-only
```

Use `pnpm turbo` for direct Turbo task runs in scripts and CI so they share the same defaults.
