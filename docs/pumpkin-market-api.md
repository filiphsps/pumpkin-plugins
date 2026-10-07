# Pumpkin Market API

This page records the Market API behavior used by this repository's publish action, the Market
frontend, and PPM. It also records the API calls tested against the unpublished
`TemporaryAPIExperiment` listing on 2026-10-07. No API token is stored here.

## Listing lookup

The public REST API is rooted at `https://market.pumpkinmc.org/api/v1/rest`.

| Request | Use |
| --- | --- |
| `GET /plugins/{id}` | Resolve a numeric database ID or the listing's public ID to its listing metadata. |
| `GET /plugins?q={name}&limit={n}` | Search listings by name. Confirm an exact name match; fail if it is ambiguous. |

The response includes the numeric `id`, `public_id`, `name`, `category`, `version` and basic listing
information. PPM accepts public IDs, numeric IDs, exact names, and author/name input when resolving a
plugin. This repository's publisher currently tries the direct endpoint first, then uses a bounded
search and requires a case-insensitive exact name match. A name is not a valid direct path value:
`GET /plugins/TemporaryAPIExperiment` returned 404, while the search endpoint found the listing.

The current publisher action accepts a plugin name or a numeric/public ID. For a name, it first
tries that value as a direct path, accepts the result only if the returned listing name matches,
and then falls back to bounded search with an exact-name check. The write endpoint itself requires
the numeric database ID in its path.

The public API documentation lists read endpoints, including plugin lookup and download. It does
not document the developer listing-write endpoint described below.

## Updating listing metadata

The Market frontend's Store Listing editor uses:

```http
PUT /api/plugins/{numeric-database-id}
Authorization: Bearer <Market API token>
Content-Type: multipart/form-data
```

The multipart form has a `metadata` part containing JSON. The frontend uses these fields:

| Field | Shape |
| --- | --- |
| `name` | Listing display name |
| `category` | Market category |
| `sourceLink` | Optional source URL |
| `youtubeVideoUrl` | Optional video URL |
| `keywords` | Search keywords |
| `translatedDescriptions` | Object mapping locale codes to description strings; the frontend's default locale is `en-US` |
| `isEarlyAccess` | Boolean |
| `commands` | Ordered array of command entries described below |

Each command entry may contain `id`, `name`, `aliases` (array), `permission`, `description` (locale
map), and `display_order`. The frontend includes the database `id` for existing command rows when
saving. It sends the complete command array in the listing form. `preview_image` is an optional
separate multipart file field. Screenshot uploads and deletes use separate endpoints and are outside
the metadata update flow.

The metadata-only update does not need a `wasm` part. Do not set the multipart `Content-Type`
manually when using `fetch` and `FormData`; the runtime must add the boundary. The frontend uses
cookie authentication and `X-Requested-With`; the API token used in this repository's publish
action instead uses the Bearer header.

The current `publish-to-pumpkin-market` action uses the same `PUT` URL with a `wasm` file and a
different `metadata` object: `version`, `track`, and `releaseNotes`. Its README documents the token
scopes used for version uploads. The test below proves that the supplied token could update the test
listing, but does not isolate the minimum scope required for metadata changes. The frontend also
surfaces a 2FA requirement for listing saves and version publishing. Whether API-token writes require
the account to have 2FA enabled has not been isolated.

## Partial and full listing updates

There is no separate `PATCH` method in the observed frontend flow: both partial metadata edits and
full listing saves use `PUT /api/plugins/{id}`. The difference is the set of keys in the JSON
`metadata` part.

The API test sent a partial object containing `translatedDescriptions` and `commands`, then read the
listing through the public REST endpoint. The listing's existing `name` and `category` remained
unchanged. A full listing object containing `name`, `category`, `sourceLink`, `youtubeVideoUrl`,
`keywords`, `translatedDescriptions`, `isEarlyAccess`, and `commands` was also accepted. A later
partial update left the full update's category unchanged. These observations support using the same
metadata-only `PUT` for both patch-style edits and complete listing updates.

Command-row reconciliation is not fully verified. The write endpoint returned success for command
arrays, but the available public REST response does not include description or command rows. A
Bearer-authenticated `GET /api/plugins/{id}` for the unpublished draft returned
`This plugin is currently offline / draft.` The frontend preserves command IDs, but the backend
behavior for omitted IDs, omitted commands, and deletion has not been confirmed.

## Tested behavior

All writes below targeted only the unpublished `TemporaryAPIExperiment` listing. No WASM binary was
uploaded, and no other listing was accessed for mutation.

- Public detail lookup by numeric database ID and public ID both returned the same listing and
  numeric database ID.
- Direct lookup by name returned 404; a bounded name search returned the exact listing.
- A Bearer-authenticated metadata-only `PUT` containing a localized description and one command
  returned HTTP 200 with `{"id":…, "status":"updated", "version":""}`.
- A full listing metadata `PUT` also returned HTTP 200. The public REST readback showed the updated
  category and retained the listing name.
- A subsequent partial metadata `PUT` returned HTTP 200 and left the category unchanged.
- The listing remained offline/draft, and no binary version was published. Its public `version`
  changed from `null` to an empty string after metadata-only writes. Because the fixture has no
  published version, this does not establish whether a metadata-only write preserves version data
  on an already-published listing.
- The test fixture is left unpublished with category `Other` and the API probe description/command
  metadata.

The request shape and command fields are confirmed by the frontend code. The API observations here do
not establish command persistence, command deletion semantics, or whether metadata-only writes
preserve version and track data on an already-published listing.

## References

- [Market frontend API client](https://github.com/Pumpkin-MC/Market-Frontend/blob/master/src/api.ts)
- [Market frontend Store Listing editor](https://github.com/Pumpkin-MC/Market-Frontend/blob/master/src/pages/dashboard/plugin/StoreListing.tsx)
- [Market frontend plugin types](https://github.com/Pumpkin-MC/Market-Frontend/blob/master/src/types/plugin.ts)
- [PPM market API client](https://github.com/Pumpkin-MC/ppm/blob/main/src/market/client.rs)
- [PPM market response models](https://github.com/Pumpkin-MC/ppm/blob/main/src/market/models.rs)
- [Pumpkin Market API docs](https://market.pumpkinmc.org/api/docs/)
- [This repository's Market publisher](../actions/publish-to-pumpkin-market/README.md)
- [CI and release workflow](ci-and-releases.md#publishing-to-marketpumpkinmcorg)
