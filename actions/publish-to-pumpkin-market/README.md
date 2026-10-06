# Publish to Pumpkin Market

Upload an existing Pumpkin plugin `.wasm` build to its existing Pumpkin Market listing. This
JavaScript action does not build the plugin or create a listing. It runs directly on GitHub Actions'
Node 24 runtime and needs no setup step.

```yaml
steps:
  - uses: filiphsps/pumpkin-plugins/actions/publish-to-pumpkin-market@publish-to-pumpkin-market-v0.0.1
    with:
      plugin-name: MyPlugin
      version: 1.2.3
      wasm-file: dist/my-plugin.wasm
      api-token: ${{ secrets.MARKET_API_TOKEN }}
      release-notes: |
        ## Changes
        - Fix plugin behavior
```

The version reference above is this action's Release Please tag. Action releases are independent
from plugin releases and other actions, and Release Please creates a new versioned tag when this
action changes. The action runs locally in this repository's release workflow from
`./actions/publish-to-pumpkin-market`.

## Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `plugin-name` | Yes | | Exact Pumpkin plugin name used by its Market listing |
| `version` | Yes | | Version to publish, without a leading `v` |
| `wasm-file` | Yes | | Path to the built `.wasm` file, relative to the workspace or absolute |
| `api-token` | No | | Market token with `plugins:update` and `plugins:versions:upload` scopes |
| `api-url` | No | `https://market.pumpkinmc.org` | Pumpkin Market base URL |
| `track` | No | `stable` | Release track |
| `release-notes` | No | Empty | Notes saved in the Market version metadata |
| `warn` | No | `false` | If `true`, missing credentials or an unavailable listing emits a warning and succeeds; otherwise it fails |

Listing lookup follows PPM: try the direct plugin endpoint, then search a limited result set and
require a case-insensitive exact name match. An empty token, missing
listing, or unpublished listing fails by default. Set `warn: true` to emit a warning and skip the
upload; API errors always fail the action. Successful and skipped uploads are added to the GitHub
Actions step summary when one is available.
