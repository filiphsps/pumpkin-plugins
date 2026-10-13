# Static Hermes Runtime

`@pumpkin-plugins/static-hermes-runtime` supplies the Static Hermes backend used by the plugin
build tool. It compiles bundled JavaScript to Hermes bytecode by default, embeds that bytecode in a
WebAssembly component, and links the Hermes VM, JSI shim, and generated Pumpkin/WASI bindings.
Direct component builds can also compile a TypeScript bundle with `-parse-ts`; Hermes marks that
parser partial and unstable. Pumpkin runs the resulting component through its WASI runtime. QuickJS
remains available as an alternative engine.
