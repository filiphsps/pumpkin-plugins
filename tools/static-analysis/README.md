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

`analyzeModuleGraph(options)` returns a `Promise<ModuleGraph>`.

`projectRoot` is resolved against the current directory. `entryPoints` needs at least one file path
relative to the project root. The function rejects absolute entry paths and paths that lead outside
the project. Symlink targets and transitive dependencies can still live outside the project. A
missing entry adds a diagnostic, and the other entries are still analyzed.

Pass the consumer's esbuild settings that affect resolution in `resolution`: `alias`, `conditions`,
`external`, `packages`, `platform`, `mainFields`, `resolveExtensions`, `nodePaths`,
`preserveSymlinks`, `tsconfig`, `tsconfigRaw` and `loader`. Defaults match esbuild, so the platform
is `browser` unless you set it. esbuild uses the project root as its working directory for these
settings. An explicit `tsconfig` path is relative to the project root. Without one, each importer
uses its nearest `tsconfig.json`. `tsconfigRaw` takes an object or a JSONC string. `extends` and
`paths` in TypeScript configs work.

esbuild resolves runtime edges with the same import or require mode as the source. A type-only edge
to an esbuild external stays external. Other type-only edges go through TypeScript's resolver to
find declarations. That resolver uses the consumer's tsconfig, aliases, conditions and symlink
setting. Its module resolution defaults to `bundler`, and an explicit `moduleResolution` in the
tsconfig wins. The platform and esbuild's implicit conditions also apply to declaration exports. If
TypeScript finds no target, the edge uses esbuild's resolved file. A declaration file never resolves
a runtime import that esbuild cannot resolve. So one mixed import can point to a JavaScript file for
its runtime edge and a different declaration file for its type-only edge. The analyzer does not
type-check source.

The analyzer follows bundled packages and their dependencies. Externals end an edge. These include
Node builtins on the `node` platform, `packages: 'external'` and wildcard patterns. Modules disabled
with `false` in a package's `browser` field also end an edge. A terminal edge keeps esbuild's
spelling of the path, which need not be absolute or name an existing file.

`resolution` does not accept esbuild plugins, because loading them would run project code. The
analyzer parses files with the JS, JSX, TS and TSX loaders. Files with other loaders are leaves. CSS
imports and code inside non-code assets are not part of the graph. The analyzer emits no bundle and
runs no project module.

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

`line` and `column` are one-based. `offset` and `length` are zero-based UTF-16 positions in the
source. An import location covers the module string, including its quotes, or the computed
argument. Entry and read failures use line 1, column 1, offset 0 and length 0.

- `unresolved-import`: a literal import has no target. Its edge stays in the graph as unresolved,
  with its specifier.
- `nonliteral-import`: an import or require target is computed or missing. Its edge stays in the
  graph as unresolved, without a specifier. The analyzer does not fold constants or expand globs.
- `unresolved-entry`: an entry point could not be resolved. Its root stays in the graph as
  unresolved.
- `unreadable-file`: a resolved code file could not be read. It stays in the graph as a leaf.
- `parse-error`: the source has a syntax error. The analyzer still follows the dependencies it can
  read.

Diagnostics come back with the partial graph instead of rejecting the promise. Check them before
you treat the graph as complete. Invalid arguments and invalid esbuild or TypeScript configuration
reject the promise.

## Publishing

This is an independently versioned public npm tool. Release Please registration and the public-tool
workflow manage its functional releases; initial npm placeholder/trusted-publisher setup follows
[Publishing public npm tools](../../docs/npm-publishing.md). Build output includes ESM and declarations;
package tests and TypeScript source are excluded from the npm artifact.

<!-- docs:begin reference -->
<!-- Generated by pumpkin-plugins-docs from package, action, extension, and component docs metadata. Run `pnpm readme`. -->

See the [API reference](https://filiphsps.github.io/pumpkin-plugins/api/tools/@pumpkin-plugins/static-analysis/) on the documentation site.
<!-- docs:end reference -->
