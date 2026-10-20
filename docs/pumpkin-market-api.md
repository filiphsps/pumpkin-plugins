---
navigation:
    category: Repository maintenance
title: "Pumpkin Market API"
description: "Market listing lookup, metadata updates, current publisher behavior and API findings"
---

# Pumpkin Market API

This page brings together the Market API behavior relevant to this repository's publisher, the
Market frontend, and PPM. It also records calls tested against the unpublished
`TemporaryAPIExperiment` listing on 2026-10-07. No API token is stored here.

## Listing lookup

The public REST API is rooted at `https://market.pumpkinmc.org/api/v1/rest`.

| Request | Use |
| --- | --- |
| `GET /plugins/{id}` | Resolve a numeric database ID or the listing's public ID to its listing metadata. |
| `GET /plugins?q={name}&limit={n}&page={p}` | Search listings by name, one 1-based page at a time. Confirm an exact name match; fail if it is ambiguous. |

The response includes the numeric `id`, `public_id`, `name`, `category`, `version`, and other basic
listing information. PPM can resolve a plugin by public ID, numeric ID, exact name, or author/name
input. This repository's publisher reads up to 10 pages of 20 results and accepts a name only when it
finds a case-insensitive exact match; past that it fails and asks for `plugin-id`. In one test, `GET /plugins/TemporaryAPIExperiment` returned
404 while search found the listing. That single result doesn't establish how direct lookup behaves
for every name.

The publisher action accepts either a plugin name or a numeric/public ID. For a name, it searches
first, then uses the listing's numeric database ID for the upload endpoint. When the listing already
shows the version being published, as on a retried release job, the action skips the upload and
still reports success.

Both Market actions cap successful listing-lookup JSON responses at 1 MiB. If a response exceeds
that limit, the action fails before uploading a plugin or changing listing metadata.

The public API documentation covers read endpoints such as plugin lookup and download. It doesn't
document the developer listing-write endpoint described below.

## Updating listing metadata

When you save the Store Listing form in the Market frontend, it sends:

```http
PUT /api/plugins/{numeric-database-id}
Authorization: Bearer <Market API token>
Content-Type: multipart/form-data
```

The multipart form includes a `metadata` part containing JSON with these fields:

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

Each command entry may contain `id`, `name`, `aliases` (an array), `permission`, `description` (a
locale map), and `display_order`. When saving, the frontend includes the database `id` for existing
command rows and sends the complete command array. You can also include `preview_image` as a separate
multipart file field. Screenshot uploads and deletes use their own endpoints, outside this metadata
update flow.

For a metadata-only update, you don't need a `wasm` part. When sending `fetch` with `FormData`, let
the runtime set the multipart `Content-Type` and its boundary. The frontend authenticates with a
cookie and sends `X-Requested-With`. This repository's publish action uses an API token in the
Bearer header instead.

The `publish-to-pumpkin-market` action uses the same `PUT` URL, but includes a `wasm` file and a
different `metadata` object with `version`, `track`, and `releaseNotes`. Its README lists the token
scopes used for version uploads. The test below confirms that its token could update the test listing;
it doesn't identify the minimum scope for metadata changes. The frontend also displays a 2FA
requirement when saving a listing or publishing a version. We haven't determined whether API-token
writes also require the account to have 2FA enabled.

## Partial and full listing updates

In the frontend flow we observed, both partial edits and full listing saves use
`PUT /api/plugins/{id}`; there is no separate `PATCH` request. The caller controls the scope of the
update by choosing which keys to include in the JSON `metadata` part.

In the API test, a partial object with `translatedDescriptions` and `commands` left the listing's
existing `name` and `category` unchanged when read through the public REST endpoint. The endpoint
also accepted a full listing object containing `name`, `category`, `sourceLink`, `youtubeVideoUrl`,
`keywords`, `translatedDescriptions`, `isEarlyAccess`, and `commands`. A later partial update left
the category from that full update unchanged. These results show that the same metadata-only `PUT`
can be used for both patch-style edits and complete listing updates.

We haven't fully verified how the backend reconciles command rows. The write endpoint accepted
command arrays, but the public REST response doesn't include descriptions or command rows. A
Bearer-authenticated `GET /api/plugins/{id}` for the unpublished draft returned
`This plugin is currently offline / draft.` Although the frontend preserves command IDs, we haven't
confirmed how the backend handles omitted IDs, omitted commands, or deletion.

## Tested behavior

Every write below targeted the unpublished `TemporaryAPIExperiment` listing. The test uploaded no
WASM binary and made no changes to any other listing.

- Public detail lookup by numeric database ID and public ID both returned the same listing and
  numeric database ID.
- Direct lookup by name returned 404; a bounded search returned the exact listing.
- A Bearer-authenticated metadata-only `PUT` containing a localized description and one command
  returned HTTP 200 with `{"id":…, "status":"updated", "version":""}`.
- A full listing metadata `PUT` also returned HTTP 200. The public REST readback showed the updated
  category and retained the listing name.
- A subsequent partial metadata `PUT` returned HTTP 200 and left the category unchanged.
- The listing stayed offline/draft, and no binary version was published. After metadata-only writes,
  its public `version` changed from `null` to an empty string. The fixture has no published version,
  so this doesn't tell us whether metadata-only writes preserve version data on a listing that has
  already been published.
- The test fixture is left unpublished with category `Other` and the API probe description/command
  metadata.

The frontend code confirms the request shape and command fields. The API tests don't confirm whether
commands persist, how command deletion works, or whether metadata-only writes preserve version and
track data on a listing that has already been published.

## References

- [Market frontend API client](https://github.com/Pumpkin-MC/Market-Frontend/blob/master/src/api.ts)
- [Market frontend Store Listing editor](https://github.com/Pumpkin-MC/Market-Frontend/blob/master/src/pages/dashboard/plugin/StoreListing.tsx)
- [Market frontend plugin types](https://github.com/Pumpkin-MC/Market-Frontend/blob/master/src/types/plugin.ts)
- [PPM market API client](https://github.com/Pumpkin-MC/ppm/blob/main/src/market/client.rs)
- [PPM market response models](https://github.com/Pumpkin-MC/ppm/blob/main/src/market/models.rs)
- [Pumpkin Market API docs](https://market.pumpkinmc.org/api/docs/)
- [This repository's Market publisher](../actions/publish-to-pumpkin-market/README.md)
- [CI and release workflow](ci-and-releases.md#publishing-to-marketpumpkinmcorg)
