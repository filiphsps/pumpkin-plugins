# Static Hermes runtime

`@pumpkin-plugins/static-hermes-runtime` supplies the Static Hermes backend used by the plugin
build tool. It compiles bundled JavaScript to Hermes bytecode, embeds that bytecode in a
WebAssembly component, and links the Hermes VM, JSI shim, and generated Pumpkin/WASI bindings.
Pumpkin runs the resulting component through its WASI runtime. QuickJS remains available as an
alternative engine.
