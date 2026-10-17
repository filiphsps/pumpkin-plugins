# Pumpkin plugin signing

`@pumpkin-plugins/signing` lets repository tooling sign and verify Pumpkin `.wasm` components with
Ed25519. Call `signWasm` and `verifyWasm` directly when building your own tooling, or use the
signing and verification GitHub Actions in a release workflow.

## Signed file contents

Signing adds `pumpkin.metadata` and `wasm_signature` custom sections to the WebAssembly file. The
signature covers the module bytes and embedded metadata. `verifyWasm` checks that signature and
returns the public key and release metadata; compare that key with one you trust before accepting a
file. Tools can inspect the sections or remove trailing signing sections, and signing replaces
existing trailing signing sections before adding a new signature.

## Metadata IDs

The metadata IDs `plugin_id`, `dev_id`, and `user_id` use the host's signed 64-bit range. Pass them
to `signWasm` as `bigint`, or as `number` when they are safe integers; unsafe numbers and values
outside that range are rejected. `verifyWasm` returns these IDs as `bigint` so JSON parsing preserves
their exact values. Convert an ID to `number` only when it falls within JavaScript's safe integer
range.

The secret key is a 32-byte Ed25519 seed, written as 64 hexadecimal characters. Keep it in a
protected secret store, and distribute the public key through a trusted channel so consumers can pin
the expected signer. A valid signature shows that the file matches its embedded metadata; it does
not establish that the signer is trusted.

The actions support signing or verifying one file or a manifest of plugins in CI. They don't build
plugins, so sign the exact `.wasm` artifact produced by your build job.
