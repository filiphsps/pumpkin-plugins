# Publish to Pumpkin Market

Upload an existing Pumpkin plugin `.wasm` build to its existing Pumpkin Market listing. Select the
listing by its exact name or numeric/public ID. This JavaScript action does not build the plugin or
create a listing. It runs directly on GitHub Actions' Node 24 runtime and needs no setup step.

```yaml
steps:
  - uses: filiphsps/pumpkin-plugins/actions/publish-to-pumpkin-market@publish-to-pumpkin-market-v0.0.2
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

Use `plugin-id` instead of `plugin-name` when the workflow already knows the listing's numeric or
public ID. Set exactly one of those inputs.

## Inputs

<!-- action-inputs:start -->
| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `plugin-name` | No |  | Exact listing name; set this or plugin-id, but not both |
| `plugin-id` | No |  | Numeric database ID or public ID; set this or plugin-name, but not both |
| `version` | Yes |  | Plugin version to publish, without a leading v |
| `wasm-file` | Yes |  | Path to the plugin .wasm file |
| `api-token` | No |  | Market API token with plugins:update and plugins:versions:upload scopes; required unless warn is true |
| `api-url` | No | `https://market.pumpkinmc.org` | Pumpkin Market base URL |
| `track` | No | `stable` | Release track |
| `release-notes` | No | `""` | Release notes to include in Market version metadata |
| `warn` | No | `false` | Warn instead of failing when credentials or the Market listing are unavailable |
<!-- action-inputs:end -->

## Outputs

<!-- action-outputs:start -->
| Output | Description |
| --- | --- |
| `listing-id` | Resolved numeric Market database ID |
| `listing-name` | Canonical Market listing name |
| `status` | Operation result (success or skipped) |
| `published-version` | Version successfully published to the listing |
<!-- action-outputs:end -->

Listing lookup follows PPM: try the direct plugin endpoint, then search a limited result set and
require a case-insensitive exact name match. An empty token, missing
listing, or unpublished listing fails by default. Set `warn: true` to emit a warning and skip the
upload; API errors always fail the action. Successful and skipped uploads are added to the GitHub
Actions step summary when one is available.
