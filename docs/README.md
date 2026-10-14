# Documentation

| Page | What it covers |
| --- | --- |
| [Team](team.md) | People contributing to `pumpkin-plugins` |
| [Home](index.md) | Documentation site landing page |
| [Documentation site](documentation-site.md) | Adding component guides, generated API reference, local preview, and publishing |
| [Creating a plugin](creating-a-plugin.md) | The `pnpm gen` generator, what it creates, and what to do next |
| [Plugin API](plugin-api/index.md) | Standalone API setup, lifecycle, host interfaces, ABI support and migration |
| [Plugin API: setup and build](plugin-api/setup-and-build.md) | Install the API and build packages and generate WIT declarations |
| [Plugin API: lifecycle and registration](plugin-api/lifecycle-and-registration.md) | Plugin lifecycle callbacks and handler registration |
| [Plugin API: host API areas](plugin-api/host-api.md) | Pumpkin WIT interfaces and WASI capability distinction |
| [Plugin API: ABI and runtime support](plugin-api/abi-and-runtime.md) | Package versions, WIT ABI alignment and runtime support notes |
| [Plugin API: evolution and migration](plugin-api/api-evolution-and-migration.md) | Compatibility decisions, migration and SemVer policy |
| [Creating an action](creating-an-action.md) | The `pnpm gen:action` generator, generated input/output docs, and release setup |
| [Plugin info and READMEs](plugin-info-and-readmes.md) | How a plugin describes itself in `src/info.ts` and how the READMEs are generated |
| [Plugin config](plugin-config.md) | Declaring settings as a schema: the file, validation, upgrades and docs all come from it |
| [Checking for plugin updates](plugin-updates.md) | Checking plugin versions against Pumpkin Market |
| [Pumpkin Market API](pumpkin-market-api.md) | Market listing lookup, metadata updates, current publisher behavior and API findings |
| [Code style](code-style.md) | Biome, the JSDoc rule, and how code is organized and tested |
| [Building](building.md) | The shared build tool, Turborepo setup, and runtime caveats |
| [Turborepo commands](turborepo.md) | The pnpm Turbo wrapper, log defaults, and flag overrides |
| [Testing](testing.md) | Unit tests and integration tests against a real Pumpkin server |
| [Benchmarking](benchmarking.md) | QuickJS and the Static Hermes profile, collector and parser matrix |
| [Port forwarding](port-forwarding.md) | UPnP and NAT-PMP for plugins: the engine, UPnPumpkin, its API and how to test them |
| [CI and releases](ci-and-releases.md) | The CI workflow, release-please, rebase-only merging and the market stub |
| [Agent tooling](agent-tooling.md) | Agent guidance, skills, portable hooks and scoped check diagnostics |
