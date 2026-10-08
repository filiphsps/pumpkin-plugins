# Publish a plugin to Pumpkin Market

The publish action uploads an already-built `.wasm` artifact to an existing Pumpkin Market
listing. It does not build the plugin or create a listing. Run it after the build and signing steps
have produced the release artifact you intend to distribute.

```yaml
- uses: OWNER/REPOSITORY/actions/publish-to-pumpkin-market@ACTION_REF
  with:
    plugin-name: MyPlugin
    version: 1.2.3
    wasm-file: dist/my-plugin.wasm
    api-token: ${{ secrets.MARKET_API_TOKEN }}
```

Replace the action reference with a published action tag or commit SHA. Set exactly one of
`plugin-name` and `plugin-id`; the action resolves a name using a bounded exact-name lookup. The
version is supplied without a leading `v`. You can also set the release track and release notes.

The token needs the Market scopes for updating plugins and uploading versions. By default, a
missing token or unavailable listing fails the step. `warn: true` changes those cases to a warning
and skipped upload; API errors still fail. The action exposes the resolved listing ID and name,
operation status, and published version as step outputs. Its generated README lists all current
inputs and outputs.
