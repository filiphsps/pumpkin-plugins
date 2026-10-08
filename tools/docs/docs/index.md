# Documentation generator

`@pumpkin-plugins/docs` defines plugin metadata and generates repository documentation from the
component sources. It reads plugin `src/info.ts`, command declarations, configuration schemas,
package manifests, component guide files, and GitHub Action metadata rather than maintaining a
separate component catalog.

## Regenerate repository docs

Run `pnpm readme` after changing plugin information, command declarations, config schemas, action
inputs or outputs, package metadata, or component guides. It updates generated README sections,
component guide and API reference links, and the root package and action tables.

Run `pnpm readme:check` to verify that generated files are current without writing them. Keep the
markers around generated README blocks in place. Change their source metadata or the Markdown
outside generated blocks instead of editing generated content by hand.

## Plugin metadata

Plugins declare their name, description, permissions, commands, compatibility notes, and config
description as typed `PluginInfo`. The same declarations feed Pumpkin metadata and generated
README tables, which helps keep runtime behavior and operator documentation aligned. Component
guides live next to the package in `docs/`; the site discovers those pages and their navigation
from the filesystem and component metadata.
