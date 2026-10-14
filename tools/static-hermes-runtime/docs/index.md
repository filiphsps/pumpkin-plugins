# Static Hermes Runtime

`@pumpkin-plugins/static-hermes-runtime` supplies the Static Hermes backend used by the plugin
build tool. It compiles bundled JavaScript to Hermes bytecode by default, embeds that bytecode in a
WebAssembly component, and links the Hermes VM, JSI shim, and generated Pumpkin/WASI bindings.
Direct component builds can also compile a TypeScript bundle with `-parse-ts`; Hermes marks that
parser partial and unstable. Pumpkin runs the resulting component through its WASI runtime. QuickJS
remains available as an alternative engine.

Static Hermes uses the Hades garbage collector by default. Set `staticHermesGc` to `"malloc"` in a
plugin's `pumpkinPlugin` configuration to use malloc-managed GC. Direct component builds accept
`gcVariant: "malloc"` in `buildStaticHermesComponent` or `--gc-variant malloc` in the CLI. The
repository's wasm32 WASI target has threads disabled, so Hades uses incremental collection instead
of its concurrent collector. The incremental path is supported by the pinned Hermes source and may
reduce collection pauses. The real-server engine comparison covers both collectors with the full
and lean runtime profiles.

The Static Hermes adapter implements dispatch for event, command, suggestion, task, custom AI-goal
and chunk-generator callbacks. AI-goal and chunk-generation callbacks receive Pumpkin resources that
are disposed when the callback returns. AI-goal boolean callbacks return `false` when their handler
throws; errors from void callbacks are logged. The pinned Pumpkin `0.2.0+26.3-26.51` host does not
start custom WASM AI goals: its eligibility methods return `false`, so gameplay does not invoke those
callbacks ([host implementation](https://github.com/Pumpkin-MC/Pumpkin/blob/0.2.0%2B26.3-26.51/crates/pumpkin/src/plugin/loader/wasm/wasm_host/wit/v0_1/mob.rs#L291-L298)).
The adapter dispatches chunk-generation callbacks when invoked by the host. See the
[lifecycle and registration guide](../../../docs/plugin-api/lifecycle-and-registration.md) for callback details.
