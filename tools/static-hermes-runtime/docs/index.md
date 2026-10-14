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
