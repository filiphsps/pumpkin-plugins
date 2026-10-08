# Verify Pumpkin plugin signatures

The verification action checks the Ed25519 signature and embedded release metadata of one or more
Pumpkin `.wasm` files. It does not modify the files. Place it after downloading or building an
artifact and before publishing, deploying, or accepting it as a dependency.

```yaml
- uses: OWNER/REPOSITORY/actions/verify-pumpkin-plugin@ACTION_REF
  with:
    wasm-file: dist/my-plugin.wasm
    expected-public-key: ${{ vars.PLUGIN_SIGNING_PUBLIC_KEY }}
    plugin-name: MyPlugin
    version: 1.2.3
```

Pin `expected-public-key` to a public key obtained through a trusted channel. Without the pin, the
action confirms that the signature matches the file and embedded metadata, but it does not identify
or authenticate the signer. `plugin-name` and `version` can additionally require exact metadata
values; versions omit a leading `v`.

For multiple files, pass a JSON `plugins-manifest` with a name, version, and wasm path for each
entry. The action checks each entry's signed metadata and reports the verified count. In single-file
mode it also exposes the name, version, developer, public key, and signing timestamp as step
outputs.
