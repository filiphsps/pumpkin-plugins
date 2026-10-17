# @pumpkin-plugins/static-analysis

Static JavaScript and TypeScript module graphs for build tools. The package reads source and package
metadata without evaluating project code. It contains no Pumpkin or WASI policy.

```ts
import { analyzeModuleGraph } from '@pumpkin-plugins/static-analysis';

const graph = await analyzeModuleGraph({
    projectRoot: '/path/to/project',
    entryPoints: ['src/main.ts', 'src/worker.ts'],
    resolution: {
        platform: 'neutral',
        tsconfig: 'tsconfig.json',
        alias: { library: './src/library.ts' },
        conditions: ['production'],
        external: ['wasi:*'],
    },
});

for (const edge of graph.edges) {
    console.log(edge.importer, edge.specifier, edge.kind, edge.resolution);
}
for (const diagnostic of graph.diagnostics) {
    console.warn(diagnostic.importer, diagnostic.location, diagnostic.message);
}
```

## Inputs and resolution

`analyzeModuleGraph(options)` returns a `Promise<ModuleGraph>`. `projectRoot` resolves relative to the
current directory. `entryPoints` must contain at least one project-relative file path; absolute paths
and lexical paths escaping the project are rejected. Symlink targets and transitive dependencies may
live outside the project. Missing roots produce diagnostics while valid roots are still analyzed.

Pass the resolution-affecting settings from the consumer's esbuild build in `resolution`:
`alias`, `conditions`, `external`, `packages`, `platform`, `mainFields`, `resolveExtensions`,
`nodePaths`, `preserveSymlinks`, `tsconfig`, `tsconfigRaw`, and `loader`. Defaults match esbuild,
including its default browser platform. Paths in these settings use the project root as esbuild's
working directory. An explicit `tsconfig` path is relative to that root; otherwise the nearest
`tsconfig.json` is discovered for each importer. `tsconfigRaw` accepts an object or JSONC string.
Inherited TypeScript configuration and path mappings are supported.

Runtime edges use esbuild's resolver with the original import/require mode. Type-only edges respect
esbuild's external boundary, then use TypeScript's resolver (bundler mode by default) with the consumer's tsconfig,
aliases, conditions and symlink setting to find declarations. Explicit TypeScript module-resolution
settings are preserved; platform and implicit esbuild conditions also apply to declaration exports. When TypeScript finds no target,
esbuild's resolved file is used. A declaration cannot rescue an unresolved **runtime** import.
Package exports may consequently select a JavaScript runtime file and a distinct declaration file
for the same mixed import. This is dependency analysis, not a TypeScript semantic typecheck.

Bundled packages and their transitive dependencies are followed. Externals (including Node builtins
on the Node platform, package-wide externals and wildcard patterns) are terminal edges. Browser
mappings disabled with `false` are also terminals. Their paths retain esbuild's resolver spelling;
an external path need not be absolute or name an existing file.

Custom esbuild plugins are not accepted: loading consumer plugins would execute project tooling.
JS/JSX/TS/TSX loaders are parsed; other assets are file leaves. CSS dependencies and source embedded
inside non-code assets are outside this JavaScript/TypeScript graph. No bundle is emitted or project
module executed.

## Graph and reachability

The result contains:

- `roots`: the requested `entryPoint` and its `resolution`, in input order.
- `files`: unique absolute `path` values and `reachability`: `runtime`, `type-only`, or `both`.
- `edges`: `importer`, optional `specifier`, `kind`, `form`, `location`, and `resolution`.
- `diagnostics`: recoverable gaps with `code`, `importer`, optional `specifier`, `location`, and `message`. Import diagnostics also identify `kind` and `form`.

Resolution is a discriminated union:

```ts
type ModuleResolution =
    | { status: 'resolved'; path: string; suffix?: string }
    | { status: 'external'; path: string }
    | { status: 'unresolved' };
```

File identities follow `preserveSymlinks`; by default they are canonical real paths. A resolver's
query/hash suffix stays on its edge, while the physical source file is analyzed once. Roots begin
with runtime reachability. A path containing any type-only edge confers type-only reachability on
all subsequent files along that path, including runtime imports inside a declaration or type-only
subgraph. A file reached by both path classes has `both`. Cycles terminate and all roots contribute
to the same graph. Edges preserve importer and target paths so consumers can reconstruct per-root
paths. Graph order is deterministic for unchanged inputs; callers should identify files by path.

Imports and re-exports, literal `require()` and `import()` calls, TypeScript import-equals,
`import()` types, and explicit type-only forms are included. Mixed named declarations emit a runtime
edge and a type-only edge. Default and namespace imports are runtime unless declared `import type`.
Labels describe syntax: this analyzer does not infer erased imports from how a binding is used or
apply tree shaking. Locally bound `require` functions and member calls such as `object.require()`
are not module imports. String literals and template literals without substitutions are literal;
computed expressions are not evaluated or expanded into guesses.

## Diagnostics

Locations use one-based `line` and `column`, and zero-based UTF-16 `offset` and `length` in the source.
Import locations cover the module literal (including quotes) or computed argument. Root/read
failures use line 1, column 1, offset 0, length 0.

- `unresolved-import`: a literal dependency has no target; its unresolved edge and specifier remain.
- `nonliteral-import`: an import/require target is computed or missing; an unresolved edge remains
  without a specifier. No constant folding or glob expansion is attempted.
- `unresolved-entry`: an entry could not be resolved; its unresolved root remains.
- `unreadable-file`: a resolved code file could not be read; it remains in the graph as a leaf.
- `parse-error`: source syntax is malformed; recoverable dependencies are still followed.

All diagnostics accompany the partial graph. They are data, not thrown resolution errors. Invalid
API arguments or invalid esbuild/TypeScript resolver configuration reject the promise. Callers must
inspect diagnostics before treating the graph as complete.

## Publishing

This is an independently versioned public npm tool. Release Please registration and the public-tool
workflow manage its functional releases; initial npm placeholder/trusted-publisher setup follows
[Publishing public npm tools](../../docs/npm-publishing.md). Build output includes ESM and declarations;
package tests and TypeScript source are excluded from the npm artifact.

<!-- docs:begin reference -->
<!-- Generated by pumpkin-plugins-docs from package, action, extension, and component docs metadata. Run `pnpm readme`. -->

See the [API reference](https://filiphsps.github.io/pumpkin-plugins/api/tools/@pumpkin-plugins/static-analysis/) on the documentation site.
<!-- docs:end reference -->
