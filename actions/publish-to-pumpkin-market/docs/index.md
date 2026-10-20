# Publish a plugin to Pumpkin Market

## Before you run the action

The action uploads a `.wasm` artifact to a Pumpkin Market listing that already exists. Run it after
your workflow has built the artifact you want to distribute. The action won't build the plugin or
create its Market listing.

## Choose the listing and version

For a workflow example and the complete input and output reference, see the
[action README](../README.md). Set exactly one of `plugin-name` or `plugin-id` to choose the listing.
When you use a name, the action reads up to 10 pages of search results and requires a
case-insensitive exact match. Supply `version` without a leading `v`; you can also set the release track and release
notes.

## Credentials and unavailable listings

Give `api-token` the `plugins:update` and `plugins:versions:upload` scopes. An empty token, a missing
listing, or a listing that hasn't been published before makes the action fail by default. Set
`warn: true` to turn those cases into a warning and skip the upload. Lookup and upload errors still
fail the action.

If the listing's current version already equals `version`, the action skips the upload and still
reports `status: success`. That lets you re-run a release job whose upload succeeded before a later
step failed.

After a successful upload, later workflow steps can use the resolved listing ID and name, operation
status, and published version from the action's outputs.
