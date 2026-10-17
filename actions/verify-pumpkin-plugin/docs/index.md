# Verify Pumpkin plugin signatures

Before you publish, deploy, or accept a Pumpkin plugin as a dependency, use this action to check its
`.wasm` file. The action verifies the Ed25519 signature and the release metadata embedded in the
file, and it leaves the file unchanged. Add it after the step that builds or downloads the artifact
so an invalid signature or unexpected metadata can stop the workflow before the artifact is used.

For a workflow example and the full input and output lists, see the [action README](../README.md).

## Choose what to verify

For one plugin, provide `wasm-file`. You can also set `plugin-name` and `version` to require exact
values in the signed metadata; provide the version without a leading `v`.

For several plugins, provide `plugins-manifest` as a JSON array. Each entry needs `plugin-name`,
`version`, and `wasm-file` fields. The action checks each file against the name and version in its
signed metadata and reports how many files passed. Set either `wasm-file` or `plugins-manifest`, not
both.

## Decide which signer to trust

Set `expected-public-key` to pin verification to a public key you obtained through a trusted channel.
The action fails if a file was signed with a different key. If you omit this input, the action still
checks that each signature matches its file and metadata, but it cannot identify or authenticate the
signer.

## Read the result

The action succeeds only when every selected file has a valid signature and passes the metadata
checks. It reports the number of verified files as `verified-count`. For a single file, it also
provides the signed plugin name, version, developer name, public key, and signing timestamp as step
outputs.
