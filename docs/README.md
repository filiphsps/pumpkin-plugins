# Documentation

| Page | What it covers |
| --- | --- |
| [Creating a plugin](creating-a-plugin.md) | The `pnpm gen` generator, what it creates, and what to do next |
| [Creating an action](creating-an-action.md) | The `pnpm gen:action` generator and the action files and release setup it creates |
| [Plugin info and READMEs](plugin-info-and-readmes.md) | How a plugin describes itself in `src/info.ts` and how the READMEs are generated |
| [Plugin config](plugin-config.md) | Declaring settings as a schema: the file, validation, upgrades and docs all come from it |
| [Checking for plugin updates](plugin-updates.md) | Checking plugin versions against Pumpkin Market |
| [Pumpkin Market API](pumpkin-market-api.md) | Market listing lookup, metadata updates, current publisher behavior and API findings |
| [Code style](code-style.md) | Biome, the JSDoc rule, and how code is organized and tested |
| [Building](building.md) | The shared build tool, Turborepo setup, and the QuickJS runtime caveats |
| [Testing](testing.md) | Unit tests and integration tests against a real Pumpkin server |
| [Port forwarding](port-forwarding.md) | UPnP and NAT-PMP for plugins: the engine, UPnPumpkin, its API and how to test them |
| [CI and releases](ci-and-releases.md) | The CI workflow, release-please, rebase-only merging and the market stub |
| [Agent tooling](agent-tooling.md) | Agent guidance, skills, portable hooks and scoped check diagnostics |
