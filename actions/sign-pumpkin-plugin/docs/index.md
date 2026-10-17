# Sign Pumpkin plugins

Use this action after building a plugin to add Pumpkin's Ed25519 signature and release metadata to
its `.wasm` file. It signs the file in place; it does not build the plugin. Pass the action the
artifact you plan to publish, then publish that same file.

For one plugin, provide its name, version without a leading `v`, and `.wasm` path. To sign several
plugins in one job, pass a JSON array of those values through `plugins-manifest`. The
`developer-name` and signing key apply to every plugin. See the [action README](../README.md) for a
workflow example and the complete input list.

Store the 32-byte Ed25519 seed as 64 hexadecimal characters in a protected GitHub secret. If a
workflow should leave plugins unsigned when the key is missing, such as a fork workflow, set
`warn: true`. The action then warns and leaves the files unchanged. A malformed key, missing file,
or failed signature verification still fails the job.

Before writing a signed file, the action replaces any existing signing section and verifies the
result. If an adjacent `.sha256` file exists, it updates that checksum to match the signed file.
The action runs on Node 24 and needs no setup step; see [action.yml](../action.yml) for its runtime
and entry point.
