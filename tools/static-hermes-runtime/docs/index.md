# Static Hermes Runtime

`@pumpkin-plugins/static-hermes-runtime` supplies the Static Hermes backend used by the plugin build
tool. It compiles bundled JavaScript to Hermes bytecode by default, embeds the bytecode in a
WebAssembly component, and links Hermes, the JSI shim, and generated Pumpkin/WASI bindings. Direct
component builds can compile a TypeScript bundle with `--parse-ts`; Hermes marks that parser partial
and unstable. Pumpkin runs the component through its WASI runtime. QuickJS remains available as an
alternative engine.

For capability imports, host permissions, and WASI resource lifetimes, see the [WASI guide](wasi.md).
Runtime maintainers changing capability bundles or native adapters should use the
[WASI maintenance guide](maintaining-wasi.md). To move the Hermes pin or change its patches, see
[Maintaining the Hermes patch series](maintaining-hermes.md).

Static Hermes uses the Hades garbage collector by default. Set `staticHermesGc` to `"malloc"` in a
plugin's `pumpkinPlugin` configuration to use malloc-managed GC. Direct component builds accept
`gcVariant: "malloc"` in `buildStaticHermesComponent` or `--gc-variant malloc` in the CLI. The
repository's wasm32 WASI target has threads disabled, so Hades uses incremental collection instead
of its concurrent collector. The incremental path is supported by the pinned Hermes source and may
reduce collection pauses. The real-server engine comparison covers both collectors with the full
and lean runtime profiles.

The Static Hermes adapter dispatches event, command, suggestion, task, custom AI-goal, and
chunk-generation callbacks. AI-goal and chunk-generation callbacks receive Pumpkin resources that
are disposed when the callback returns. AI-goal boolean callbacks return `false` when their handler
throws; errors from void callbacks are logged. See the
[lifecycle and registration guide](../../../docs/plugin-api/lifecycle-and-registration.md) for
callback details.

<!-- docs:begin custom-goal-host-limit -->
<!-- Generated from tools/test-harness/src/pumpkin-version.ts. Run `pnpm readme`. -->

The pinned Pumpkin host `0.2.0+26.3-26.51` does not start custom WASM AI goals: its eligibility methods return
`false`, so gameplay does not invoke those callbacks. See the [host implementation](https://github.com/Pumpkin-MC/Pumpkin/blob/0.2.0%2B26.3-26.51/crates/pumpkin/src/plugin/loader/wasm/wasm_host/wit/v0_1/mob.rs).
<!-- docs:end custom-goal-host-limit -->
