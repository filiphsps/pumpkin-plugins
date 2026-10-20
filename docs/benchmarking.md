---
navigation:
    category: Repository maintenance
title: "Benchmarking"
description: "QuickJS and the Static Hermes profile, collector and parser matrix"
---

# Compare QuickJS and Static Hermes

This guide shows you how to run the repository's engine comparison and how much to read into its results. It builds a production WebAssembly component for a QuickJS baseline and for every Static Hermes configuration, then runs the same workloads on Pumpkin. The results compare these builds on this workload suite. They can't predict which engine will be faster for a particular plugin.

## Run the comparison

From the repository root, run:

    pnpm --filter @pumpkin-plugins/engine-comparison compare-engines

The command first runs the cacheable `benchmark:build` Turbo task, then runs the real-server integration test in [engine-comparison.itest.ts](../benchmarks/engine-comparison/test/engine-comparison.itest.ts). Turbo caches the comparison components and the stack-guard fixtures under configuration-specific paths in `build/engine-comparison/`. It can reuse them when the benchmark sources, build dependencies, and declared build environment match. The test starts a fresh Pumpkin server for each comparison component, runs the benchmark command, collects its results, and stops the server.

CI runs each engine configuration as its own matrix job, along with a stack-guard check for each Static Hermes profile. Each engine job uploads its result. The report job checks that all configurations ran the same workloads and produced matching checksums, then adds the combined Markdown report to the job summary. It uploads the combined JSON results and report for 90 days; individual engine result artifacts are kept for one day. Static Hermes preparation runs automatically when a local build needs it. In CI, the pinned toolchain is restored and verified before the comparison runs in the [engine comparison workflow](../.github/workflows/engine-comparison.yml).

After a pull-request CI run produces a complete report, a separate trusted workflow updates one benchmark comment on the PR, even if another CI job failed. It compares the results with the newest successful default-branch benchmark that is an ancestor of the PR base. By default, changes within 10% count as runner jitter; set the repository variable `BENCHMARK_JITTER_PERCENT` to change that threshold. A median that moves by less than 1 ms also counts as jitter, whatever the percentage, so very short workloads don't raise warnings on small timing noise. A slower result beyond the threshold gets a warning. A significant improvement gets a celebration if there are no regressions; otherwise, the comment reports the run without a performance alert. The comment links to the full matrix report, embeds an SVG chart of the largest changes, and links to the chart for download. If no matching baseline artifact exists, it says so and leaves timing changes unclassified.

The benchmark plugin lives in [benchmark-plugin.ts](../benchmarks/engine-comparison/src/benchmark-plugin.ts). [benchmark-workloads.ts](../benchmarks/engine-comparison/src/benchmark-workloads.ts) lists the workloads in report order and times them; the workloads themselves are grouped by topic in [src/workloads](../benchmarks/engine-comparison/src/workloads/).

## What the comparison runs

Each configuration uses the same benchmark plugin source and workloads:

- **QuickJS** bundles the JavaScript as an ES module and turns it into a component with this repository's QuickJS runtime.
- **Static Hermes** covers all combinations of the `full` and `lean` runtime profiles, Hades and malloc collectors, and JavaScript and TypeScript parser modes.
- **Full** keeps runtime source compilation available. **Lean** omits it, so `eval` and the `Function` constructor are unavailable.
- **JavaScript parser mode** uses Hermes's default parser. **TypeScript parser mode** enables Hermes's `--parse-ts` flag.

The parser setting changes a compiler flag, not the benchmark code or inputs. [engine-variants.ts](../benchmarks/engine-comparison/src/engine-variants.ts) defines the matrix.

Here, "Static Hermes" means Hermes is linked into the WASI component. The plugin's JavaScript is compiled to Hermes bytecode before the component runs; it is not translated into native Wasm instructions. JIT is disabled in this WASI build. Pumpkin runs every configuration as a Wasm component, not as a native desktop engine binary.

Production builds minify the bundle. The build tool warns about components above 5 MiB (5,242,880 bytes) and fails on them when `PUMPKIN_PLUGINS_FAIL_ON_SIZE_LIMIT=1` is set. See the [Static Hermes Runtime guide](../tools/static-hermes-runtime/README.md) and [build guide](building.md) for build flags, pinned tools, and runtime details.

## Method and scope

Every configuration gets the same workload source and input count. The integration test compares deterministic checksums across all configurations and pins expected checksums for selected string and command fixtures. It also checks that:

- every engine reports the same workload identifiers, input counts, and checksums;
- each timed workload has one un-timed warm-up followed by five measured samples;
- the production component is non-empty and within the build-size limit;
- the plugin registers its command and exercises selected real Pumpkin API behavior.

The benchmark uses JavaScript `Date.now()`, so timings are whole milliseconds and the clock may have coarser resolution. For each workload, the report shows the median of five samples and their minimum-to-maximum range. Timing covers the workload body only; it excludes component compilation, server startup, plugin loading, and dispatch of the outer benchmark command.

<!-- docs:begin workload-summary -->
<!-- Generated from benchmark-workloads.ts and benchmark-plugin.ts. Run `pnpm readme`. -->

There are 34 timed workloads: 33 deterministic guest-side fixtures and 1 real Pumpkin API call.
<!-- docs:end workload-summary -->

These fixture algorithms are examples written for this benchmark. They don't run the named plugins or Pumpkin's own command router. Player-oriented fixtures use in-memory test data rather than connected players.

Locally, the test runs configurations one at a time in a fixed order: QuickJS first, then each Static Hermes profile, collector, and parser-mode combination. It starts a fresh server for each one. CI runs the configurations in parallel. The real API workload calls `server.getAllPlayers()` in every sample; because the test server has no connected players, each call returns an empty list. Separately, the test registers and dispatches a real `server.command()` command and checks event and scheduled-task behavior. That command dispatch checks API behavior; it is not a timed command-routing workload.

### Workload inventory

"Inputs per sample" is the configured number of items or requests a workload processes. For example, `string-join` repeats the same join several times per sample, so its count includes every part across those joins. Different workloads count different kinds of input, so compare timings for the same workload rather than comparing counts across rows. The inventory is generated from the benchmark registry and API workload definition.

<!-- docs:begin workload-inventory -->
<!-- Generated from benchmark-workloads.ts and benchmark-plugin.ts. Run `pnpm readme`. -->

| Kind | Workload | Inputs per sample | What it represents |
| --- | --- | --- | --- |
| Synthetic | `numeric` | 1,000,000 | Numeric arithmetic baseline |
| Synthetic | `objects` | 50,000 | Object allocation and traversal |
| Synthetic | `strings` | 25,000 | String construction and joining |
| Synthetic | `string-construction` | 25,000 | String part construction |
| Synthetic | `string-join` | 1,600,000 | Batched dense ASCII array joining |
| Synthetic | `string-radix-integer` | 25,000 | Integer radix formatting |
| Synthetic | `string-join-unicode` | 7 | Unicode join correctness and code-unit behavior |
| Synthetic | `string-repeat-ascii` | 4,000 | Repeated ASCII string construction |
| Synthetic | `string-pad-ascii` | 8,000 | ASCII string padding at both ends |
| Synthetic | `array-to-locale-string-ascii` | 32,000 | Locale string conversion for ASCII array elements |
| Synthetic | `string-case-ascii` | 16,000 | ASCII string case conversion |
| Synthetic | `typed-array-join-ascii` | 128,000 | ASCII typed array joining |
| Synthetic | `typed-array-locale-ascii` | 64,000 | ASCII typed array locale conversion |
| Synthetic | `string-from-char-code-ascii` | 8,000 | ASCII multi-argument character code conversion |
| Synthetic | `string-replace-ascii` | 16,000 | ASCII string replace and replaceAll |
| Synthetic | `config-validation` | 1,000 | Configuration parsing and validation |
| Synthetic | `command-routing` | 4,000 | Command tokenization, alias resolution and route-map lookup |
| Synthetic | `command-tokenization` | 4,000 | Command tokenization |
| Synthetic | `command-route-lookup` | 4,000 | Command alias and route-map lookup |
| Synthetic | `permission-resolution` | 12,000 | Permission inheritance and context lookup |
| Synthetic | `player-directory` | 18,000 | Player and home lookups |
| Synthetic | `event-cache` | 20,000 | Lifecycle cache updates |
| Synthetic | `chat-formatting` | 3,000 | Chat template formatting and filtering |
| Synthetic | `scoreboard-rendering` | 12,000 | Scoreboard text rendering |
| Synthetic | `region-protection` | 20,000 | Region containment and access checks |
| Synthetic | `world-edit-plan` | 55,296 | Block-edit plan generation |
| Synthetic | `economy-transfers` | 12,000 | Balance transfer processing |
| Synthetic | `inventory-stacking` | 2,500 | Inventory stack allocation |
| Synthetic | `cooldown-rate-limit` | 20,000 | Cooldown and rate-limit checks |
| Synthetic | `tick-scheduler` | 6,000 | Scheduled task processing |
| Synthetic | `audit-history` | 13,000 | Audit history filtering |
| Synthetic | `player-state-json` | 1,200 | Player-state JSON round trip |
| Synthetic | `custom-payload` | 16,384 | Custom payload encoding |
| Real API | `pumpkin-api` | 10,000 | Pumpkin server.getAllPlayers() |
<!-- docs:end workload-inventory -->

String and command workloads include combined cases and narrower sub-operations. The string cases cover construction, joining, radix formatting, Unicode behavior and ASCII-heavy built-ins. Command routing combines tokenization, alias resolution and lookup; separate rows measure tokenization and lookup.

## Reading the report

The report shows production component sizes, timings and ratios for each workload, and an arithmetic-mean summary.

- **Component sizes** are final production component byte counts. Size differences use QuickJS as the baseline: negative means smaller than QuickJS, positive means larger.
- **Per-workload timings** show each engine's median and sample range in milliseconds. A lower time means that engine finished that workload sooner in that run.
- **QuickJS/engine** is the QuickJS median divided by that Static Hermes configuration's median. A ratio above 1 means Hermes was lower; below 1 means QuickJS was lower. A ratio shown as 1.00x can be a rounded tie, especially for workloads close to the timer's one-millisecond resolution.
- **Average benchmark median** is the arithmetic mean of the per-workload medians. It gives every workload equal weight, even though their input counts and work differ. Use it as a compact report statistic, not as a score for plugin or server performance.

The integration test has no timing thresholds. Timing results are diagnostic evidence, while checksum, API behavior, and component-size checks provide pass/fail assertions.

## Latest results

CI runs the comparison for `master` pushes that change code. To see current numbers, open the newest successful [CI run on `master`](https://github.com/filiphsps/pumpkin-plugins/actions/workflows/ci.yml?query=branch%3Amaster+is%3Asuccess) and read the summary of its `📋 Collect and display results` job under Engine comparison. The run also keeps the combined report and JSON results as the `engine-comparison-report` artifact for 90 days. A pull request's benchmark comment shows the same report with timing changes against that baseline.

## Interpreting the results

The results show how each build performed on these fixtures, on one runner, in one run. Keep these limits in mind before you draw a conclusion:

- Compare the same workload across engines, never rows against each other. Input counts differ by design, so a million arithmetic iterations and 1,000 config validations aren't equivalent units.
- Five samples in whole milliseconds can show large differences but not small ones. A sample can take zero milliseconds, and the report can't calculate a ratio when the denominator median is zero.
- Runner hardware and load, Wasmtime and Pumpkin versions, toolchain pins and source changes all affect timings. GitHub-hosted runners don't report a CPU model, so compare runs only for the same revisions and environment.
- The real API row calls one method that returns an empty list. It doesn't measure other Pumpkin calls or the cost of converting large host results.
- Component sizes are for the benchmark plugin. A plugin's imports, bundled dependencies, API usage and build profile change its size.
- The report has no profiler output or heap and GC counters, so it can't explain why an engine was faster. Profile the code before you attribute a difference to the interpreter, built-ins, allocation or the host boundary.

For an engine or plugin decision, benchmark the plugin's own hot path with realistic data and production build settings.

## For runtime and CI contributors

If you change the benchmark or its CI workflow, keep these guarantees in place:

- Use identical workload code and input counts across engine builds, and preserve the deterministic checksum checks.
- Keep labels clear about provenance: guest-side synthetic fixture or real Pumpkin API.
- Keep API behavior assertions separate from timed synthetic algorithms unless you're explicitly measuring the API path.
- Remember that adding a workload or changing fixture inputs changes what the average means.
- Include the runner image and source revision with any published comparison. Include CPU details only when the runner exposes them.
- Use the runtime guide for the pinned Hermes/WASI toolchain and build configuration; use the test harness guide for server selection and startup behavior.

The comparison is maintained in [engine-comparison.itest.ts](../benchmarks/engine-comparison/test/engine-comparison.itest.ts), [engine-variants.ts](../benchmarks/engine-comparison/src/engine-variants.ts), [benchmark-workloads.ts](../benchmarks/engine-comparison/src/benchmark-workloads.ts), [benchmark-plugin.ts](../benchmarks/engine-comparison/src/benchmark-plugin.ts), and the [comparison workflow](../.github/workflows/engine-comparison.yml). See [Testing](testing.md) for the real-server harness.

## Sources

- [QuickJS official documentation](https://bellard.org/quickjs/quickjs.html): engine overview, interpreter/compiler, bytecode, and memory handling.
- [Hermes official build and execution guide](https://github.com/facebook/hermes/blob/main/doc/BuildingAndRunning.md): Hermes bytecode compiler and execution modes.
- [Pumpkin plugin build guide](building.md) and [Static Hermes Runtime guide](../tools/static-hermes-runtime/README.md): this repository's component build, engine profiles, and WASI configuration.
