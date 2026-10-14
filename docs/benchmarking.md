# Benchmarking QuickJS and Static Hermes

This guide explains what the engine comparison measures, how to read its report, and what conclusions its results support. It is intended for plugin authors, Pumpkin developers, runtime and CI contributors, and readers curious about the trade-offs.

The comparison builds nine production WebAssembly components and exercises them on a real Pumpkin server: a QuickJS baseline plus eight Static Hermes configurations. The Hermes matrix combines runtime profiles (`full` and `lean`), collectors (Hades and malloc), and parser modes (JavaScript and TypeScript). It is a focused workload suite, not a universal JavaScript-engine ranking.

## What the comparison runs

The build tool bundles the same benchmark plugin source and workloads for each configuration:

- **QuickJS** bundles JavaScript as an ES module and "componentizes" it with this repository’s QuickJS runtime.
- **Static Hermes** covers every combination of full/lean profile, Hades/malloc collector, and JavaScript/TypeScript parser mode.
- **Full** retains runtime source compilation. **Lean** omits it, so `eval` and the `Function` constructor are unavailable.
- **JavaScript parser mode** uses Hermes's default parser. **TypeScript parser mode** passes `--parse-ts` to Hermes.

The parser axis changes the compiler flag; it does not change the benchmark workload source or inputs. The matrix currently runs one QuickJS build and eight Static Hermes builds.

Here, “Static Hermes” means Hermes linked into the WASI component. The plugin’s JavaScript is compiled to Hermes bytecode before the component runs; the benchmark does not translate JavaScript into native Wasm instructions. JIT is disabled for the WASI build. Every configuration is a Wasm component executed by Pumpkin’s runtime, not a native desktop engine binary.

Production builds minify the bundle and enforce the repository’s 5 MiB component limit (5,242,880 bytes). Build flags, toolchain pins, and runtime details are in the [Static Hermes Runtime guide](../tools/static-hermes-runtime/README.md) and [build guide](building.md).

## Run the comparison

From the repository root:

    pnpm --filter @pumpkin-plugins/engine-comparison compare-engines

The command first runs the cacheable `benchmark:build` Turbo task, then runs the real-server integration
test in [engine-comparison.test.ts](../benchmarks/engine-comparison/test/engine-comparison.test.ts).
The task caches the nine comparison components and two stack-guard fixtures under separate,
configuration-specific output paths in `build/engine-comparison/`. Turbo hashes the benchmark sources,
build dependencies, and declared build environment. The matrix is one cache task, so a change to any
build input rebuilds all eleven components. The integration test starts one Pumpkin server for each
comparison component, dispatches the benchmark command, collects results, then stops the server.
Static Hermes preparation runs automatically when a build needs it; CI also restores and verifies its
pinned toolchain before comparing engines in the [engine comparison workflow](../.github/workflows/engine-comparison.yml).

The benchmark plugin and workload definitions are in [benchmark-plugin.ts](../benchmarks/engine-comparison/src/benchmark-plugin.ts) and [benchmark-workloads.ts](../benchmarks/engine-comparison/src/benchmark-workloads.ts). GitHub Actions appends the report to the job summary.

## Method and scope

Each configuration receives the same workload source and input count. The integration test checks that all nine configurations return matching deterministic checksums for every workload; it also pins expected checksum values for selected string and command fixtures. It checks that:

- every engine reports the same workload identifiers, input counts, and checksums;
- each timed workload has one un-timed warm-up followed by five measured samples;
- the production component is non-empty and within the build-size limit;
- the plugin registers its command and exercises selected real Pumpkin API behavior.

Workload timing uses JavaScript `Date.now()`, so samples are reported as integer milliseconds; the clock may be coarser in practice. For each workload, the report shows the median and the minimum-to-maximum range of the five samples. The timer covers the workload body; it does not include component compilation, server startup, plugin loading, or dispatching the outer benchmark command.

There are 26 timed workloads: 25 deterministic guest-side fixtures and one real Pumpkin API call. The fixture algorithms are representative examples written for this benchmark; they are not executions of the named plugins or Pumpkin’s own command router. Player-directory and other player-oriented fixture workloads use in-memory test data, not connected players.

The configurations run serially: QuickJS first, then each Static Hermes profile, collector, and parser-mode combination, each with a newly started server. The real API workload calls `server.getAllPlayers()` 10,000 times per sample, or 60,000 calls per configuration including the warm-up and five measured samples. The test server has no connected players, so the returned list is empty. The test separately registers and dispatches one real `server.command()` command, along with event and scheduled-task behavior checks. That command dispatch is API behavior coverage, not a timed command-routing workload.

### Workload inventory

“Inputs per sample” is the fixture’s configured loop or request count. It describes work within that particular row; it is not a common unit that makes different rows directly comparable. For `string-join`, the count is array-element visits across all 64 joins in one sample.

| Kind | Workload | Inputs per sample | What it represents |
| --- | --- | ---: | --- |
| Synthetic | `numeric` | 1,000,000 | Numeric arithmetic baseline |
| Synthetic | `objects` | 50,000 | Object allocation and traversal |
| Synthetic | `strings` | 25,000 | String construction followed by joining |
| Synthetic | `string-construction` | 25,000 | Construction of string parts |
| Synthetic | `string-join` | 1,600,000 | 64 joins of the same prebuilt dense array of 25,000 ASCII strings |
| Synthetic | `string-radix-integer` | 25,000 | Converting integers from 0 through 24,999 to base 36 |
| Synthetic | `string-join-unicode` | 7 | Joining sparse and mixed-Unicode values with a non-ASCII separator |
| Synthetic | `config-validation` | 1,000 | JSON parsing and configuration validation |
| Synthetic | `command-routing` | 4,000 | Guest-side tokenization, alias resolution, and route-map lookup |
| Synthetic | `command-tokenization` | 4,000 | Command tokenization in isolation |
| Synthetic | `command-route-lookup` | 4,000 | Alias and route-map lookup in isolation |
| Synthetic | `permission-resolution` | 12,000 | Permission inheritance and context lookup |
| Synthetic | `player-directory` | 18,000 | Player and home lookups against fixtures |
| Synthetic | `event-cache` | 20,000 | Lifecycle cache updates |
| Synthetic | `chat-formatting` | 3,000 | Chat-template formatting and filtering |
| Synthetic | `scoreboard-rendering` | 12,000 | Scoreboard text rendering |
| Synthetic | `region-protection` | 20,000 | Region containment and access checks |
| Synthetic | `world-edit-plan` | 55,296 | Block-edit plan generation |
| Synthetic | `economy-transfers` | 12,000 | Balance transfer processing |
| Synthetic | `inventory-stacking` | 2,500 | Inventory stack allocation |
| Synthetic | `cooldown-rate-limit` | 20,000 | Cooldown and rate-limit checks |
| Synthetic | `tick-scheduler` | 6,000 | Scheduled-task processing |
| Synthetic | `audit-history` | 13,000 | Audit-history filtering |
| Synthetic | `player-state-json` | 1,200 | Player-state JSON round trip |
| Synthetic | `custom-payload` | 16,384 | Custom payload encoding |
| Real API | `pumpkin-api` | 10,000 | Calls to `server.getAllPlayers()` |

The string and command rows deliberately separate composite work from selected sub-operations. The composite string workload constructs and joins 25,000 parts; `string-construction` and `string-join` isolate construction and batched joining. The join repeats the same dense ASCII array 64 times per sample to make its timing easier to resolve with the millisecond clock. `string-radix-integer` uses the same 25,000-number range as the construction fixture and checks radix boundaries, negative and maximum safe integers, negative zero, fractional fallback, and an integer above the safe range. `string-join-unicode` checks a non-ASCII separator, ASCII/BMP/supplementary characters, holes, `null`, `undefined`, and a `toString` side effect that mutates an earlier array entry. JavaScript strings remain UTF-16 code-unit sequences, so the supplementary character contributes two to `String.length`. Command routing combines tokenization, alias resolution, and route lookup; the standalone tokenization and lookup rows help show which portion may account for a difference.

## Reading the report

The current report contains production component sizes, per-workload timings and ratios, and an arithmetic-mean summary.

- **Component sizes** are final production component byte counts. Size differences use QuickJS as the baseline: negative means smaller than QuickJS, positive means larger.
- **Per-workload timings** show each engine’s median and sample range in milliseconds. Lower time means that engine completed that particular workload sooner in that run.
- **QuickJS/engine** is the QuickJS median divided by that Static Hermes configuration's median. A ratio above 1 means Hermes was lower; below 1 means QuickJS was lower. A ratio shown as 1.00x can be a rounded tie, especially for workloads close to the timer’s one-millisecond resolution.
- **Average benchmark median** is the arithmetic mean of the 26 per-workload medians. Every workload contributes equally, despite different input counts and different kinds of work. Treat it as a compact report statistic, not a representative plugin or server-performance score.

The integration test has no timing thresholds. Timing results are diagnostic evidence, while checksum, API behavior, and component-size checks provide pass/fail assertions.

## Example CI result

The [engine-comparison job linked from PR 99](https://github.com/filiphsps/pumpkin-plugins/actions/runs/38254750702/job/114834399434?pr=99) is one reference result. It checked out the PR merge ref at commit `2a4cfa19157cfabed67f41de16b199c3fc1c0775` on a GitHub-hosted Ubuntu 26.04 runner. The run is evidence for that merge candidate and runner only; it does not describe master or another revision. The job log does not identify the runner’s CPU model. This historical run predates the GC and parser axes in the current matrix; it compares QuickJS with full and lean Hermes using Hades GC. It also predates the repeated join and radix/Unicode workloads described above, so its string-join row measures a single join and is not a result for the current workload.

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

The linked run shows workload-specific differences, not one engine that wins every kind of work. QuickJS was faster in its command-tokenization and string-construction fixtures. Full and lean Hermes were faster in the numeric baseline and several state-processing fixtures, with especially large ratios in economy-transfers and audit-history. The real API row favored QuickJS for repeated empty-list `getAllPlayers()` calls. None of these results alone predicts a plugin’s end-to-end performance.

Several mechanisms could contribute to the pattern, but this benchmark does not profile them:

- **Bytecode and interpreter behavior.** Both runtimes execute JavaScript through their own engine-specific representations and virtual machines in this WASI setup. Differences in instruction dispatch, optimization choices, and runtime implementation can affect arithmetic and control-heavy loops. The benchmark has no instruction-level profile to identify a cause.
- **Built-in operations and strings.** String construction, joining, JSON, maps, and object operations pass through different engine implementations. In the linked run, the separate join row is only about one millisecond, while construction and combined strings take longer and favor QuickJS. This is consistent with construction contributing more of the measured string difference, but the rows do not isolate every internal operation.
- **Allocation and garbage collection.** Object-heavy or state-heavy workloads may respond to object layout, allocation strategy, and collection timing. The report records no heap, allocation, or GC counters, so these remain hypotheses rather than findings.
- **Wasm host boundary.** The API row includes real Pumpkin/WIT/JSI call plumbing as well as the JavaScript call loop. Because the server has no players, it does not measure converting or traversing a large player list. It cannot distinguish host-call overhead from the other work in the call path.
- **Workload shape.** A fixture may reward one engine’s built-ins or implementation details without representing a production plugin’s data sizes, branches, object lifetimes, API calls, or tick cadence.

For engine or plugin decisions, benchmark the plugin’s actual hot path with realistic data and the same production build settings. Use a profiler or targeted counters before assigning a cause to a timing difference.

## Limits and interpretation rules

- The linked table is one run of one PR merge candidate. Hardware, host load, Wasmtime/Pumpkin versions, toolchain pins, and source changes can alter results. Use the linked job for provenance and compare like-for-like revisions and environments.
- The job log identifies a GitHub-hosted Ubuntu 26.04 runner but not its CPU model. Do not infer a CPU from the operating-system image.
- Five samples with integer-millisecond timing can expose large differences in these workloads, but cannot resolve small differences reliably. A zero-millisecond sample is possible; ratios are unavailable when the denominator median is zero.
- Engine runs are serial and always follow the same order. Changes in host load during a job can affect later variants; the comparison does not alternate engine order or repeat independent server runs.
- Input counts differ by design. A million arithmetic iterations and 1,000 config validations are not equivalent units. Do not average or compare rows as if they were normalized operations.
- The arithmetic mean weights all 24 workload medians equally. A single slower row can move it substantially, and changing the workload set changes its meaning.
- The real API case is narrow. It measures one API method with an empty result and does not represent all Pumpkin calls or guest-to-host conversion costs.
- Component size is the benchmark plugin’s final component size. Plugin imports, bundled dependencies, API usage, and build profile change the result.

## For runtime and CI contributors

The test owns the compared variants, checksum assertions, workload counts, output format, and the GitHub job summary. When changing it:

- Keep workload code identical across engine builds, and preserve equal input counts and deterministic checksum checks.
- Keep labels clear about provenance: guest-side synthetic fixture or real Pumpkin API.
- Keep API behavior assertions separate from timed synthetic algorithms unless the API path itself is explicitly being measured.
- Treat new workload rows and changes to fixture inputs as changes to the meaning of the average.
- Report the runner image and source revision with any published comparison. Include CPU details only when the runner actually exposes them.
- Use the runtime guide for the pinned Hermes/WASI toolchain and build configuration; use the test harness guide for server selection and startup behavior.

The maintained implementation is in [engine-comparison.test.ts](../benchmarks/engine-comparison/test/engine-comparison.test.ts), [engine-variants.ts](../benchmarks/engine-comparison/test/engine-variants.ts), [benchmark-workloads.ts](../benchmarks/engine-comparison/src/benchmark-workloads.ts), [benchmark-plugin.ts](../benchmarks/engine-comparison/src/benchmark-plugin.ts), and the [comparison workflow](../.github/workflows/engine-comparison.yml). The real-server harness is documented in [Testing](testing.md).

## Sources

- [QuickJS official documentation](https://bellard.org/quickjs/quickjs.html): engine overview, interpreter/compiler, bytecode, and memory handling.
- [Hermes official build and execution guide](https://github.com/facebook/hermes/blob/main/doc/BuildingAndRunning.md): Hermes bytecode compiler and execution modes.
- [Pumpkin plugin build guide](building.md) and [Static Hermes Runtime guide](../tools/static-hermes-runtime/README.md): this repository’s component build, engine profiles, and WASI configuration.
- [PR 99 engine-comparison job](https://github.com/filiphsps/pumpkin-plugins/actions/runs/38254750702/job/114834399434?pr=99): source revision, runner context, component sizes, and workload output for the example above.
