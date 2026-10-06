# Sign Pumpkin plugin

Add Pumpkin's Ed25519 signature and release metadata to an existing plugin `.wasm` file. This
action signs the file in place; it does not build the plugin.

```yaml
steps:
  - uses: filiphsps/pumpkin-plugins/actions/sign-pumpkin-plugin@sign-pumpkin-plugin-v0.0.1
    with:
      plugin-name: MyPlugin
      version: 1.2.3
      wasm-file: dist/my-plugin.wasm
      developer-name: My Name
      signing-key: ${{ secrets.PLUGIN_SIGNING_KEY }}
```

The version reference above is this action's Release Please tag. Action releases are independent
from plugin releases and other actions, and Release Please creates a versioned tag when this action
changes.

The action uses the repository's tested `@pumpkin-plugins/signing` implementation and verifies its
output before writing it. Existing signing sections are replaced. If a sibling
`<wasm-file>.sha256` checksum file exists, the action updates it to match the signed bytes. Its
`.mjs` entrypoint loads the shared TypeScript signer with Node 24's built-in type stripping, so it
does not need a separate build or bundle step.

## Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `plugin-name` | Yes | | Exact Pumpkin plugin name embedded in the signature metadata |
| `version` | Yes | | Plugin version, without a leading `v` |
| `wasm-file` | Yes | | `.wasm` path, relative to the workspace or absolute |
| `developer-name` | Yes | | Developer name embedded in the signature metadata |
| `signing-key` | No | | 32-byte Ed25519 secret seed as 64 hexadecimal characters |
| `warn` | No | `false` | If `true`, an empty key emits a warning and leaves the file unchanged; otherwise it fails |

An empty key can be skipped with `warn: true`, which is useful for forks and repositories that
release unsigned plugins. A malformed key, missing file, or failed signature verification always
fails. The action runs on GitHub's Node 24 runtime and needs no extra runner setup.
