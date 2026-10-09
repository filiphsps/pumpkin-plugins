# Update a Pumpkin Market listing

The metadata action updates fields on an existing Market listing. It does not build or upload a
plugin, create listings, read `info.ts`, or upload screenshots. Use it after the listing has been
created and reviewed in Market.

For a workflow example and the complete input list, see the [action README](../README.md).

Provide either `plugin-name` or `plugin-id`. The JSON metadata file uses Market field names; direct
inputs can be layered over it and override the matching field. The `description` input sets the
English description while preserving other translated descriptions. Use a metadata file when an
explicit empty value is needed because empty direct inputs are omitted.

The default `patch` mode sends only supplied fields and leaves the rest of the listing unchanged.
`full` mode requires every listing field: name, category, source link, YouTube URL, keywords,
translated descriptions, early-access flag, and commands. The token must have listing-update
permission. The step outputs the resolved listing ID, canonical name, and operation status; the
generated README lists all current input names and JSON fields.
