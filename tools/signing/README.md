# @pumpkin-plugins/signing

Signs and verifies plugin `.wasm` files in the format Pumpkin checks (Ed25519 over the module and a `pumpkin.metadata` section).

An internal package of [pumpkin-plugins](https://github.com/filiphsps/pumpkin-plugins): it is not
published to npm, and the plugins in this repo use it as a workspace dependency. See [the docs](../../docs/ci-and-releases.md)
for how it is used, and the [API reference](https://filiphsps.github.io/pumpkin-plugins/api/tools/@pumpkin-plugins/signing/)
on the documentation site.
