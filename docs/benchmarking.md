---
title: "Benchmarking"
description: "QuickJS and the Static Hermes profile, collector and parser matrix"
---

# Compare QuickJS and Static Hermes

This guide shows you how to run the repository's engine comparison and how much to read into its results. It builds nine production WebAssembly components—a QuickJS baseline and eight Static Hermes configurations—and runs the same workloads on Pumpkin. The results help compare these builds on this workload suite; they can't predict which engine will be faster for every plugin.

## Run the comparison

From the repository root, run:

    pnpm --filter @pumpkin-plugins/engine-comparison compare-engines

The command first runs the cacheable `benchmark:build` Turbo task, then runs the real-server integration test in [engine-comparison.test.ts](../benchmarks/engine-comparison/test/engine-comparison.test.ts). Turbo caches the nine comparison components and two stack-guard fixtures under configuration-specific paths in `build/engine-comparison/`. It can reuse them when the benchmark sources, build dependencies, and declared build environment match. The test starts a fresh Pumpkin server for each comparison component, runs the benchmark command, collects its results, and stops the server.

CI runs the nine engine configurations as parallel matrix jobs, along with both stack-guard checks. Each engine job uploads its result. The report job checks that all configurations ran the same workloads and produced matching checksums, then adds the combined Markdown report to the job summary. It uploads the combined JSON results and report for 90 days; individual engine result artifacts are kept for one day. Static Hermes preparation runs automatically when a local build needs it. In CI, the pinned toolchain is restored and verified before the comparison runs in the [engine comparison workflow](../.github/workflows/engine-comparison.yml).

After a pull-request CI run produces a complete report, a separate trusted workflow updates one benchmark comment on the PR, even if another CI job failed. It compares the results with the newest successful default-branch benchmark that is an ancestor of the PR base. By default, changes within 10% count as runner jitter; set the repository variable `BENCHMARK_JITTER_PERCENT` to change that threshold. A slower result beyond the threshold gets a warning. A significant improvement gets a celebration if there are no regressions; otherwise, the comment reports the run without a performance alert. The comment links to the full matrix report, embeds an SVG chart of the largest changes, and links to the chart for download. If no matching baseline artifact exists, it says so and leaves timing changes unclassified.

The benchmark plugin and workload definitions live in [benchmark-plugin.ts](../benchmarks/engine-comparison/src/benchmark-plugin.ts) and [benchmark-workloads.ts](../benchmarks/engine-comparison/src/benchmark-workloads.ts).

## What the comparison runs

Each configuration uses the same benchmark plugin source and workloads:

- **QuickJS** bundles the JavaScript as an ES module and turns it into a component with this repository's QuickJS runtime.
- **Static Hermes** covers all combinations of the `full` and `lean` runtime profiles, Hades and malloc collectors, and JavaScript and TypeScript parser modes.
- **Full** keeps runtime source compilation available. **Lean** omits it, so `eval` and the `Function` constructor are unavailable.
- **JavaScript parser mode** uses Hermes's default parser. **TypeScript parser mode** enables Hermes's `--parse-ts` flag.

The parser setting changes a compiler flag, not the benchmark code or inputs. The matrix has one QuickJS build and eight Static Hermes builds.

Here, “Static Hermes” means Hermes is linked into the WASI component. The plugin's JavaScript is compiled to Hermes bytecode before the component runs; it is not translated into native Wasm instructions. JIT is disabled in this WASI build. Pumpkin runs every configuration as a Wasm component, not as a native desktop engine binary.

Production builds minify the bundle. For plugins built inside this repository, the build tool enforces a 5 MiB component limit (5,242,880 bytes). External consumers get a warning and can continue. See the [Static Hermes Runtime guide](../tools/static-hermes-runtime/README.md) and [build guide](building.md) for build flags, pinned tools, and runtime details.

## Method and scope

Every configuration gets the same workload source and input count. The integration test compares deterministic checksums across all nine configurations and pins expected checksums for selected string and command fixtures. It also checks that:

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

“Inputs per sample” is the configured number of items or requests a workload processes. For example, `string-join` joins 25,000 parts 64 times, so its count is 1,600,000. Different workloads count different kinds of input, so compare timings for the same workload rather than comparing counts across rows. The inventory is generated from the benchmark registry and API workload definition.

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
- **QuickJS/engine** is the QuickJS median divided by that Static Hermes configuration's median. A ratio above 1 means Hermes was lower; below 1 means QuickJS was lower. A ratio shown as 1.00x can be a rounded tie, especially for workloads close to the timer’s one-millisecond resolution.
- **Average benchmark median** is the arithmetic mean of the per-workload medians. It gives every workload equal weight, even though their input counts and work differ. Use it as a compact report statistic, not as a score for plugin or server performance.

The integration test has no timing thresholds. Timing results are diagnostic evidence, while checksum, API behavior, and component-size checks provide pass/fail assertions.

## Example CI result

For a concrete example, see the [engine-comparison job from PR 99](https://github.com/filiphsps/pumpkin-plugins/actions/runs/38254750702/job/114834399434?pr=99). It checked out merge commit `2a4cfa19157cfabed67f41de16b199c3fc1c0775` on a GitHub-hosted Ubuntu 26.04 runner. Treat it as evidence for that merge candidate and runner; it says nothing about master or other revisions. The log does not identify the runner's CPU model. This older run predates the GC and parser axes in today's matrix: it compares QuickJS with full and lean Hermes, both using Hades GC. It also predates the repeated join and radix/Unicode workloads, so its `string-join` row measures a single join and cannot be compared directly with the current workload.

### Component sizes in that run

| Engine | Component size | Difference from QuickJS |
| --- | ---: | ---: |
| QuickJS | 5,081,200 bytes | Baseline |
| Static Hermes full | 3,643,322 bytes | −1,437,878 bytes (−28.30%) |
| Static Hermes lean | 2,130,174 bytes | −2,951,026 bytes (−58.08%) |

The QuickJS component was 161,680 bytes below the 5 MiB limit. Lean was 1,513,148 bytes smaller than full in this build. These are sizes for the benchmark plugin and build configuration, not fixed sizes for arbitrary plugins.

### Per-workload results in that run

Times are median milliseconds, with minimum–maximum samples in parentheses. The final columns show the QuickJS-to-Hermes ratios defined above.

| Workload | Inputs per sample | QuickJS ms | Full ms | Lean ms | QuickJS/full | QuickJS/lean |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `numeric` | 1,000,000 | 114 (113–114) | 72 (71–72) | 77 (77–91) | 1.58x | 1.48x |
| `objects` | 50,000 | 15 (15–16) | 12 (8–43) | 13 (9–44) | 1.25x | 1.15x |
| `strings` | 25,000 | 8 (8–9) | 22 (21–23) | 23 (22–28) | 0.36x | 0.35x |
| `string-construction` | 25,000 | 8 (8–10) | 19 (15–23) | 22 (15–26) | 0.42x | 0.36x |
| `string-join` | 25,000 | 1 (0–1) | 1 (0–1) | 1 (0–1) | 1.00x | 1.00x |
| `config-validation` | 1,000 | 8 (8–9) | 10 (10–12) | 11 (11–14) | 0.80x | 0.73x |
| `command-routing` | 4,000 | 45 (45–46) | 99 (94–100) | 102 (98–104) | 0.45x | 0.44x |
| `command-tokenization` | 4,000 | 38 (38–39) | 91 (90–94) | 93 (92–99) | 0.42x | 0.41x |
| `command-route-lookup` | 4,000 | 1 (1–2) | 1 (0–1) | 1 (1–1) | 1.00x | 1.00x |
| `permission-resolution` | 12,000 | 22 (21–22) | 30 (27–31) | 31 (27–31) | 0.73x | 0.71x |
| `player-directory` | 18,000 | 17 (17–18) | 28 (27–33) | 31 (29–35) | 0.61x | 0.55x |
| `event-cache` | 20,000 | 29 (28–30) | 53 (49–55) | 56 (53–59) | 0.55x | 0.52x |
| `chat-formatting` | 3,000 | 35 (34–36) | 52 (48–53) | 53 (50–53) | 0.67x | 0.66x |
| `scoreboard-rendering` | 12,000 | 103 (100–111) | 154 (152–161) | 164 (160–170) | 0.67x | 0.63x |
| `region-protection` | 20,000 | 21 (20–21) | 28 (28–29) | 28 (28–29) | 0.75x | 0.75x |
| `world-edit-plan` | 55,296 | 23 (23–24) | 11 (11–12) | 12 (11–12) | 2.09x | 1.92x |
| `economy-transfers` | 12,000 | 145 (143–153) | 14 (9–19) | 16 (10–20) | 10.36x | 9.06x |
| `inventory-stacking` | 2,500 | 11 (10–11) | 5 (4–6) | 5 (4–6) | 2.20x | 2.20x |
| `cooldown-rate-limit` | 20,000 | 12 (11–12) | 16 (15–17) | 17 (16–21) | 0.75x | 0.71x |
| `tick-scheduler` | 6,000 | 10 (10–11) | 8 (5–9) | 9 (5–10) | 1.25x | 1.11x |
| `audit-history` | 13,000 | 73 (72–75) | 9 (5–10) | 9 (5–10) | 8.11x | 8.11x |
| `player-state-json` | 1,200 | 17 (17–19) | 12 (7–13) | 12 (8–14) | 1.42x | 1.42x |
| `custom-payload` | 16,384 | 4 (3–4) | 2 (2–2) | 2 (2–2) | 2.00x | 2.00x |
| `pumpkin-api` | 10,000 | 11 (11–12) | 39 (38–44) | 39 (39–44) | 0.28x | 0.28x |

In this run, full Hermes had a lower median than QuickJS on 9 rows, QuickJS had a lower median on 13, and 2 displayed as ties. Lean had the same count split. Those ties are at the reported precision; they do not establish equal execution cost. The large spread on some rows, such as object allocation, is also a reminder that a five-sample range can expose variability rather than eliminate it.

## What the results suggest—and what they do not prove

The example shows differences by workload, not one engine winning across the board. QuickJS was faster in the command-tokenization and string-construction fixtures. Full and lean Hermes were faster in the numeric baseline and several state-processing fixtures, especially `economy-transfers` and `audit-history`. QuickJS was faster on the real API row, which repeatedly calls `getAllPlayers()` and gets an empty list. None of these results predicts a plugin's end-to-end performance on its own.

Several things could explain the pattern, but this benchmark doesn't profile them:

- **Bytecode and interpreter behavior.** Both runtimes use their own JavaScript representations and virtual machines in this WASI setup. Instruction dispatch, optimization choices, and runtime implementation could affect arithmetic and control-heavy loops. There is no instruction-level profile to tell us which, if any, caused a timing difference.
- **Built-ins and strings.** String construction, joining, JSON, maps, and object operations use engine-specific implementations. In the example run, the separate join row takes about one millisecond, while construction and combined string work take longer and favor QuickJS. That suggests construction may account for more of the measured difference, but the workloads don't isolate every internal operation.
- **Allocation and garbage collection.** Object-heavy or state-heavy work may respond to object layout, allocation strategy, or collection timing. The report has no heap, allocation, or GC counters, so these are possibilities, not findings.
- **The Wasm host boundary.** The API row includes real Pumpkin/WIT/JSI call plumbing and the JavaScript call loop. Since the server has no players, it doesn't measure converting or traversing a large player list. The result can't separate host-call overhead from the rest of that call path.
- **Workload shape.** A fixture might favor an engine's built-ins or implementation details without matching a production plugin's data sizes, branches, object lifetimes, API calls, or tick cadence.

For an engine or plugin decision, benchmark the plugin's actual hot path with realistic data and production build settings. Use a profiler or targeted counters before attributing a timing difference to a particular cause.

## Limits and interpretation rules

- The table is one run of one PR merge candidate. Hardware, host load, Wasmtime and Pumpkin versions, toolchain pins, and source changes can all affect results. Use the linked job for provenance, and compare the same revisions and environments.
- The job log identifies a GitHub-hosted Ubuntu 26.04 runner but not its CPU model. Do not infer a CPU from the operating-system image.
- Five samples measured in whole milliseconds can reveal large differences, but they can't reliably resolve small ones. A sample may take zero milliseconds; the report can't calculate a ratio when its denominator median is zero.
- Locally, the comparison runs configurations serially in a fixed order. CI gives each one a matrix job, but runner differences can affect timings, and a job doesn't repeat on multiple runners.
- Input counts differ by design. A million arithmetic iterations and 1,000 config validations are not equivalent units. Do not average or compare rows as if they were normalized operations.
- The arithmetic mean weights every workload median equally. A single slower row can move it substantially, and changing the workload set changes its meaning.
- The real API case is narrow: it measures one API method with an empty result, not all Pumpkin calls or guest-to-host conversion costs.
- Component size is the benchmark plugin's final component size. Plugin imports, bundled dependencies, API usage, and build profile change the result.

## For runtime and CI contributors

If you change the benchmark or its CI workflow, keep these guarantees in place:

- Use identical workload code and input counts across engine builds, and preserve the deterministic checksum checks.
- Keep labels clear about provenance: guest-side synthetic fixture or real Pumpkin API.
- Keep API behavior assertions separate from timed synthetic algorithms unless you're explicitly measuring the API path.
- Remember that adding a workload or changing fixture inputs changes what the average means.
- Include the runner image and source revision with any published comparison. Include CPU details only when the runner exposes them.
- Use the runtime guide for the pinned Hermes/WASI toolchain and build configuration; use the test harness guide for server selection and startup behavior.

The comparison is maintained in [engine-comparison.test.ts](../benchmarks/engine-comparison/test/engine-comparison.test.ts), [engine-variants.ts](../benchmarks/engine-comparison/test/engine-variants.ts), [benchmark-workloads.ts](../benchmarks/engine-comparison/src/benchmark-workloads.ts), [benchmark-plugin.ts](../benchmarks/engine-comparison/src/benchmark-plugin.ts), and the [comparison workflow](../.github/workflows/engine-comparison.yml). See [Testing](testing.md) for the real-server harness.

## Sources

- [QuickJS official documentation](https://bellard.org/quickjs/quickjs.html): engine overview, interpreter/compiler, bytecode, and memory handling.
- [Hermes official build and execution guide](https://github.com/facebook/hermes/blob/main/doc/BuildingAndRunning.md): Hermes bytecode compiler and execution modes.
- [Pumpkin plugin build guide](building.md) and [Static Hermes Runtime guide](../tools/static-hermes-runtime/README.md): this repository’s component build, engine profiles, and WASI configuration.
- [PR 99 engine-comparison job](https://github.com/filiphsps/pumpkin-plugins/actions/runs/38254750702/job/114834399434?pr=99): source revision, runner context, component sizes, and workload output for the example above.
