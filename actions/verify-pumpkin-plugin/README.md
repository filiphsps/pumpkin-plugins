# Verify Pumpkin plugin

Verifies the Ed25519 signature on one or more `.wasm` files. You can also check the embedded plugin
name and version or pin the expected public key.

See the [Verify Pumpkin plugin reference](https://filiphsps.github.io/pumpkin-plugins/api/actions/verify-pumpkin-plugin/)
on the documentation site.

```yaml
steps:
  - uses: filiphsps/pumpkin-plugins/actions/verify-pumpkin-plugin@verify-pumpkin-plugin-v0.0.1
    with:
      wasm-file: dist/my-plugin.wasm
      expected-public-key: ${{ vars.PLUGIN_SIGNING_PUBLIC_KEY }}
      plugin-name: MyPlugin
      version: 1.2.3
```

The version reference above is this action's first Release Please tag. Action releases are
independent from plugin releases and other actions.

The action checks the Pumpkin Ed25519 signature and can pin the public key to a trusted publisher.
Without `expected-public-key`, it confirms that the signature matches the file and its embedded
metadata, but it does not establish who signed it. Optional `plugin-name` and `version` inputs also
check the values embedded in the signed metadata.

For several files, provide a JSON manifest with the same `plugin-name`, `version`, and `wasm-file`
fields accepted by the signing action:

```yaml
steps:
  - uses: filiphsps/pumpkin-plugins/actions/verify-pumpkin-plugin@verify-pumpkin-plugin-v0.0.1
    with:
      plugins-manifest: ${{ runner.temp }}/plugins.json
      expected-public-key: ${{ vars.PLUGIN_SIGNING_PUBLIC_KEY }}
```

The manifest's plugin name and version are checked against each file's signed metadata. The action
does not modify files.

## Inputs

<!-- action-inputs:start -->
| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `wasm-file` | No |  | Path to one signed Pumpkin plugin .wasm file; use this or plugins-manifest |
| `plugins-manifest` | No |  | JSON manifest of plugin-name, version, and wasm-file entries to verify; use this or wasm-file |
| `expected-public-key` | No |  | Expected 32-byte Ed25519 public key as 64 hexadecimal characters; pins the trusted signer |
| `plugin-name` | No |  | Single-file mode; fail unless the signed metadata contains this exact plugin name |
| `version` | No |  | Single-file mode; fail unless the signed metadata contains this exact version |
<!-- action-inputs:end -->

## Outputs

<!-- action-outputs:start -->
| Output | Description |
| --- | --- |
| `verified-count` | Number of files successfully verified |
| `plugin-name` | Single-file mode; plugin name from the signed metadata |
| `version` | Single-file mode; version from the signed metadata |
| `developer-name` | Single-file mode; developer name from the signed metadata |
| `public-key` | Single-file mode; public key embedded in the signature |
| `issued-at` | Single-file mode; signing timestamp from the signed metadata |
<!-- action-outputs:end -->

## Development

Add inputs and outputs in `action.yml`, implement the behavior in `src/index.mjs`, and cover it with
tests in `src/*.test.mjs`. Input and output tables are generated from `action.yml`; run `pnpm readme`
after changing the action metadata. Read inputs with `getInput()` and write outputs with
`setOutput()` from `../../common/src/utils.mjs` so values use GitHub's runner environment and
output-file format. These helpers and their tests are shared by all actions.
The action runs on GitHub's Node 24 runtime and needs no separate build step.
