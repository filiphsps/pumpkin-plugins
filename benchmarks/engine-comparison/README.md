# Engine comparison

This private benchmark compares QuickJS with eight Static Hermes builds using the same plugin
workloads on a real Pumpkin server. Use it to compare these engine configurations against the
workloads in this repository; the results don't rank JavaScript engines generally or predict how a
particular plugin will perform.

## Run the comparison

From the repository root, run:

```sh
pnpm --filter @pumpkin-plugins/engine-comparison compare-engines
```

The command builds the nine WebAssembly components, then starts a Pumpkin server for each one and
runs the benchmark plugin. It prints component sizes and workload timings, and checks that the builds
produce matching results. Build outputs are stored under
`benchmarks/engine-comparison/build/engine-comparison/` and can be reused on later runs.

## What changes between builds

The QuickJS build is the baseline. The eight Static Hermes builds cover every combination of two
runtime profiles (`full` and `lean`), two garbage collectors (Hades and malloc), and two parser modes
(JavaScript and TypeScript). The `lean` profile omits runtime source compilation, so `eval` and the
`Function` constructor are unavailable.

## For contributors

Run the unit suite for report formatting, workload definitions, engine variants, and benchmark
support scripts with:

```sh
pnpm --filter @pumpkin-plugins/engine-comparison test
```

When your change affects how an engine build runs on Pumpkin, use the real-server comparison above
to build and check all nine configurations.

For the workload list, measurement method, report interpretation, and comparison limits, see the [benchmarking guide](../../docs/benchmarking.md).
