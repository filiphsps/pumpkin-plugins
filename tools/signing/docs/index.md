# Pumpkin plugin signing

`@pumpkin-plugins/signing` signs and verifies Pumpkin `.wasm` components with Ed25519 metadata.
Use `signWasm` and `verifyWasm` when integrating signing into repository tooling; the GitHub Actions
provide a ready-made workflow step for release pipelines.

## Signed file contents

Signing appends Pumpkin metadata and signature custom sections to the WebAssembly file. Verification
checks the signature against the module bytes and embedded metadata and reports the signing key and
release fields. Signing sections can be stripped or parsed when a tool needs to inspect or replace
them. Existing signature sections are replaced when producing a new signature.

The key is a 32-byte Ed25519 seed, represented in workflows as 64 hexadecimal characters. Keep the
secret key in a protected secret store; publish the public key through a separately trusted channel
so consumers can pin the expected signer. A valid signature proves the file matches its metadata,
but trust depends on how the public key was obtained.

Use the action interface for one-file or manifest-based CI signing and verification. These helpers
do not build plugins; sign the exact `.wasm` artifact produced by the build job.
