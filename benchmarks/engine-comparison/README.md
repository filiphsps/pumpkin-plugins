# @pumpkin-plugins/engine-comparison

Private real-server comparison of a QuickJS baseline and eight Static Hermes plugin builds. The
Static Hermes matrix combines full/lean runtime profiles, Hades/malloc collectors, and JS/TS parser
modes. Run unit tests with `pnpm --filter @pumpkin-plugins/engine-comparison test` and the complete
Pumpkin comparison with `pnpm --filter @pumpkin-plugins/engine-comparison compare-engines`.

See the [benchmarking guide](../../docs/benchmarking.md) for workloads, report details, and how to
interpret results.
