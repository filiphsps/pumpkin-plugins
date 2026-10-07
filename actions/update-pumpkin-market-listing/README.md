# Update Pumpkin Market Listing

Update Pumpkin Market listing metadata from a JSON file or direct inputs

```yaml
steps:
  - uses: filiphsps/pumpkin-plugins/actions/update-pumpkin-market-listing@update-pumpkin-market-listing-v0.0.1
```

The version reference above is this action's first Release Please tag. Action releases are
independent from plugin releases and other actions.

## Development

Add inputs and outputs in `action.yml`, implement the behavior in `src/index.mjs`, and cover it with
tests in `src/*.test.mjs`. Read inputs with `getInput()` from `src/utils.mjs` so hyphenated input
names keep matching GitHub's runner environment. The action runs on GitHub's Node 24 runtime and
needs no separate build step.
