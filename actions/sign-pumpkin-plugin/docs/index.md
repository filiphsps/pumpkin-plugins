# Sign Pumpkin plugins

The signing action adds Pumpkin's Ed25519 signature and release metadata to one or more existing
plugin `.wasm` files. It signs in place and does not build them. Run it on the exact artifact from
the build job, before publishing or distributing that artifact.

For a workflow example and the complete input list, see the [action README](../README.md).

For one file, provide the plugin name, version without a leading `v`, and wasm path. For a release
with several plugins, use `plugins-manifest`, a JSON array of those three values; the developer
name and key apply to every item. The action replaces existing signing sections, verifies the
result before writing, and refreshes an adjacent `.sha256` file when one exists.

Store the 32-byte Ed25519 seed as 64 hexadecimal characters in a protected GitHub secret. Set
`warn: true` only when a missing key should intentionally leave files unsigned, such as a fork
workflow. Malformed keys, missing files, and failed verification remain errors. The action runs on
GitHub Actions' Node 24 runtime and needs no setup step.
