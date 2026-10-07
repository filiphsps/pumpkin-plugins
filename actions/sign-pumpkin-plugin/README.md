# Sign Pumpkin plugin

Add Pumpkin's Ed25519 signature and release metadata to one or more existing plugin `.wasm` files.
This action signs files in place; it does not build the plugins.

See the [Sign Pumpkin plugin reference](https://filiphsps.github.io/pumpkin-plugins/api/actions/sign-pumpkin-plugin/)
on the documentation site.

```yaml
steps:
  - uses: filiphsps/pumpkin-plugins/actions/sign-pumpkin-plugin@sign-pumpkin-plugin-v0.0.5
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

For CI jobs that need to sign multiple plugins, provide a JSON array manifest instead of the three
single-plugin inputs:

```json
[
  { "plugin-name": "MyPlugin", "version": "1.2.3", "wasm-file": "dist/my-plugin.wasm" }
]
```

The action signs each entry and refreshes any adjacent checksums. `developer-name` and
`signing-key` still apply to every entry.

## Inputs

<!-- action-inputs:start -->
| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `plugin-name` | No |  | Single-file mode; exact plugin name embedded in the signature metadata |
| `version` | No |  | Single-file mode; plugin version embedded without a leading v |
| `wasm-file` | No |  | Single-file mode; path to the plugin .wasm file to sign |
| `plugins-manifest` | No |  | Batch mode; JSON array of plugin-name, version, and wasm-file entries instead of single-file inputs |
| `developer-name` | Yes |  | Developer name embedded in signed metadata; required in either mode |
| `signing-key` | No |  | 32-byte Ed25519 secret seed as 64 hexadecimal characters; required unless warn is true |
| `warn` | No | `false` | Warn and leave the file unchanged when signing-key is empty instead of failing |
<!-- action-inputs:end -->

## Outputs

<!-- action-outputs:start -->
This action has no outputs.
<!-- action-outputs:end -->

An empty key can be skipped with `warn: true`, which is useful for forks and repositories that
release unsigned plugins. A malformed key, missing file, or failed signature verification always
fails. The action runs on GitHub's Node 24 runtime and needs no extra runner setup.
