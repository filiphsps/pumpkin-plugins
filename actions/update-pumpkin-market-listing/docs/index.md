# Update a Pumpkin Market listing

Use this action to change metadata on a listing that already exists in Pumpkin Market. It’s useful
when the listing details need an update independently of a plugin upload. The action doesn’t create
listings, read `src/info.ts`, build or upload a WASM file, or manage screenshots.

## Choose the listing and prepare its metadata

Set exactly one of `plugin-name` and `plugin-id`. A name must be an exact match, regardless of
capitalization; the action fails if it finds no match or more than one. An ID can be the numeric
database ID or the listing’s public ID.

You can provide metadata in a JSON file, with direct inputs, or with both. The JSON file uses Market
field names such as `name`, `sourceLink`, and `translatedDescriptions`. Direct inputs override the
matching fields from the file; for example, `display-name` sets `name`. The `description` input
updates the `en-US` description and keeps other translations from the file.

Blank direct inputs are omitted, so they don’t clear a value already on the listing. If you need to
send an explicit empty value for a field that accepts one, put that value in the JSON file. The
[action README](../README.md) has a workflow example, an example metadata file, and the complete
input reference.

## Decide how much metadata to send

`update-mode` defaults to `patch`. In this mode, the action sends only the metadata fields you
provided. Use it for a focused edit, such as changing the description while leaving other listing
details alone.

Set `update-mode: full` when you want to provide the complete listing metadata. The action requires
all of these fields in the combined metadata before it sends the update: `name`, `category`,
`sourceLink`, `youtubeVideoUrl`, `keywords`, `translatedDescriptions`, `isEarlyAccess`, and
`commands`. Both modes use Market’s metadata `PUT` endpoint; `patch` and `full` describe which
fields the action accepts, not different HTTP methods.

In a test against an unpublished listing, Market left the existing name and category unchanged
when a partial update omitted them. Command row reconciliation and preservation of version or
track data on published listings haven’t been confirmed. If your update includes commands or
targets a published listing, review the result in Market. See the
[Market API notes](../../../docs/pumpkin-market-api.md#partial-and-full-listing-updates) for the
tested behavior and its limits.

## Run the action and check the result

Provide an API token that can update listing metadata. The minimum token scope hasn’t been
established; the [Market API notes](../../../docs/pumpkin-market-api.md#updating-listing-metadata)
describe the token behavior that has been tested. `api-url` defaults to
`https://market.pumpkinmc.org`; set it only when you use a different Market instance. It must use
https, because the action sends the token to it. For a complete
workflow example, see the [action README](../README.md).

After Market accepts the update, the action reports `status: success` and sets `listing-id` and
`listing-name` to the resolved database ID and canonical listing name. If lookup, validation, or the
Market update fails, the workflow step fails before it writes success outputs.
