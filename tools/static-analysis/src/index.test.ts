import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { analyzeModuleGraph } from './index.ts';

const projects: string[] = [];
afterEach(async () => {
    await Promise.all(projects.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function project(files: Record<string, string>) {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'static-analysis-')));
    projects.push(root);
    await Promise.all(
        Object.entries(files).map(async ([file, contents]) => {
            await mkdir(dirname(join(root, file)), { recursive: true });
            await writeFile(join(root, file), contents);
        }),
    );
    return root;
}

test('combines multiple roots and follows cyclic runtime dependencies without executing them', async () => {
    const root = await project({
        'a.ts': "import './shared.js'; throw new Error('must not execute');",
        'b.js': "export * from './shared.js';",
        'shared.js': "require('./a.ts');",
        'unreachable.ts': "import './missing';",
    });
    const graph = await analyzeModuleGraph({ projectRoot: root, entryPoints: ['a.ts', 'b.js'] });
    expect(graph.roots.map((entry) => entry.resolution)).toEqual([
        { status: 'resolved', path: join(root, 'a.ts') },
        { status: 'resolved', path: join(root, 'b.js') },
    ]);
    expect(graph.files.map((file) => [file.path, file.reachability]).sort()).toEqual([
        [join(root, 'a.ts'), 'runtime'],
        [join(root, 'b.js'), 'runtime'],
        [join(root, 'shared.js'), 'runtime'],
    ]);
    expect(graph.edges.map((edge) => [edge.specifier, edge.kind, edge.resolution.status])).toEqual([
        ['./shared.js', 'runtime', 'resolved'],
        ['./shared.js', 'runtime', 'resolved'],
        ['./a.ts', 'runtime', 'resolved'],
    ]);
    expect(graph.diagnostics).toEqual([]);
});

test('keeps mixed declarations, import types and type-only subgraphs separate from runtime reachability', async () => {
    const root = await project({
        'main.ts': `import { value, type Shape } from './shared';
export { value, type Shape } from './shared';
import type Only from './only';
export type * from './only';
type Inline = import('./inline').Inline;
import Legacy = require('./legacy.cts');
import type LegacyType = require('./only');
const lazy = import('./lazy');
const common = require('./common.cjs');`,
        'shared.ts': 'export const value = 1; export type Shape = {};',
        'only.ts': "import './shared'; import './type-transitive'; export default interface Only {}",
        'type-transitive.ts': 'export {};',
        'inline.d.ts': 'export interface Inline {}',
        'legacy.cts': 'export = {};',
        'lazy.ts': 'export {};',
        'common.cjs': 'module.exports = {};',
    });
    const graph = await analyzeModuleGraph({ projectRoot: root, entryPoints: ['main.ts'] });
    expect(
        graph.edges
            .filter((edge) => edge.importer === join(root, 'main.ts'))
            .map((edge) => [edge.specifier, edge.kind, edge.form]),
    ).toEqual([
        ['./shared', 'runtime', 'import'],
        ['./shared', 'type-only', 'import'],
        ['./shared', 'runtime', 're-export'],
        ['./shared', 'type-only', 're-export'],
        ['./only', 'type-only', 'import'],
        ['./only', 'type-only', 're-export'],
        ['./inline', 'type-only', 'import-type'],
        ['./legacy.cts', 'runtime', 'import-equals'],
        ['./only', 'type-only', 'import-equals'],
        ['./lazy', 'runtime', 'dynamic-import'],
        ['./common.cjs', 'runtime', 'require'],
    ]);
    expect(
        Object.fromEntries(graph.files.map((file) => [file.path.slice(root.length + 1), file.reachability])),
    ).toEqual({
        'main.ts': 'runtime',
        'shared.ts': 'both',
        'only.ts': 'type-only',
        'type-transitive.ts': 'type-only',
        'inline.d.ts': 'type-only',
        'legacy.cts': 'runtime',
        'lazy.ts': 'runtime',
        'common.cjs': 'runtime',
    });
    expect(graph.diagnostics).toEqual([]);
});

test('returns partial graphs and source-located diagnostics for missing and computed imports', async () => {
    const root = await project({
        'main.ts': `import './ok';
import './missing';
export type { Absent } from './missing-types';
const lazy = import(name);
const common = require('./' + name);
type Missing = import('./missing-inline').Shape;
require();`,
        'ok.ts': 'export {};',
    });
    const graph = await analyzeModuleGraph({ projectRoot: root, entryPoints: ['missing.ts', 'main.ts'] });
    expect(graph.roots[0].resolution).toEqual({ status: 'unresolved' });
    expect(graph.files.map((file) => file.path)).toEqual([join(root, 'main.ts'), join(root, 'ok.ts')]);
    expect(
        graph.diagnostics.map(({ code, specifier, location }) => [code, specifier, location.line, location.column]),
    ).toEqual([
        ['unresolved-entry', 'missing.ts', 1, 1],
        ['unresolved-import', './missing', 2, 8],
        ['unresolved-import', './missing-types', 3, 29],
        ['nonliteral-import', undefined, 4, 21],
        ['nonliteral-import', undefined, 5, 24],
        ['unresolved-import', './missing-inline', 6, 23],
        ['nonliteral-import', undefined, 7, 1],
    ]);
    expect(graph.edges.filter((edge) => edge.resolution.status === 'unresolved')).toHaveLength(6);
    expect(
        graph.diagnostics.every((diagnostic) => diagnostic.importer.startsWith(root) && diagnostic.message.length > 0),
    ).toBe(true);
    const missing = graph.edges.find((edge) => edge.specifier === './missing');
    expect(missing?.location).toEqual({ line: 2, column: 8, offset: 22, length: 11 });
});

test('uses consumer aliases, conditions, externals, extensions and tsconfig paths for transitive packages', async () => {
    const root = await project({
        'main.ts': `import 'chosen'; import 'conditional'; const c = require('conditional');
import { type Shape, value } from 'typed';
import '#local'; import 'custom'; import 'ignore/subpath'; import './external';`,
        'tsconfig.build.json': JSON.stringify({ compilerOptions: { paths: { '#local': ['./src/local.ts'] } } }),
        'src/local.ts': 'export {};',
        'src/aliased.ts': "import 'transitive';",
        'external.ts': "import 'must-not-traverse';",
        'node_modules/conditional/package.json': JSON.stringify({
            exports: { special: { import: './special.js', require: './special.cjs' }, default: './default.js' },
        }),
        'node_modules/conditional/special.js': 'export {};',
        'node_modules/conditional/special.cjs': 'module.exports = {};',
        'node_modules/conditional/default.js': "throw new Error('wrong condition');",
        'node_modules/typed/package.json': JSON.stringify({
            exports: { types: './index.d.ts', default: './index.js' },
        }),
        'node_modules/typed/index.js': 'export const value = 1;',
        'node_modules/typed/index.d.ts': "export type Shape = import('./nested').Shape; export const value: number;",
        'node_modules/typed/nested.d.ts': 'export interface Shape {}',
        'node_modules/transitive/package.json': '{"main":"index.js"}',
        'node_modules/transitive/index.js': "import 'ignore';",
        'node_modules/custom/package.json': '{"main":"index"}',
        'node_modules/custom/index.custom': 'export {};',
    });
    const graph = await analyzeModuleGraph({
        projectRoot: root,
        entryPoints: ['main.ts'],
        resolution: {
            alias: { chosen: './src/aliased.ts' },
            conditions: ['special'],
            external: ['ignore', './external.ts'],
            resolveExtensions: ['.custom', '.ts', '.js', '.cjs'],
            loader: { '.custom': 'js' },
            tsconfig: 'tsconfig.build.json',
        },
    });
    expect(graph.diagnostics).toEqual([]);
    expect(
        graph.edges.filter((edge) => edge.importer === join(root, 'main.ts')).map((edge) => edge.resolution),
    ).toEqual([
        { status: 'resolved', path: join(root, 'src/aliased.ts') },
        { status: 'resolved', path: join(root, 'node_modules/conditional/special.js') },
        { status: 'resolved', path: join(root, 'node_modules/conditional/special.cjs') },
        { status: 'resolved', path: join(root, 'node_modules/typed/index.js') },
        { status: 'resolved', path: join(root, 'node_modules/typed/index.d.ts') },
        { status: 'resolved', path: join(root, 'src/local.ts') },
        { status: 'resolved', path: join(root, 'node_modules/custom/index.custom') },
        { status: 'external', path: 'ignore/subpath' },
        { status: 'external', path: join(root, 'external.ts') },
    ]);
    expect(graph.files).toContainEqual({
        path: join(root, 'node_modules/transitive/index.js'),
        reachability: 'runtime',
    });
    expect(graph.files).toContainEqual({
        path: join(root, 'node_modules/typed/nested.d.ts'),
        reachability: 'type-only',
    });
    expect(graph.edges.some((edge) => edge.specifier === 'must-not-traverse')).toBe(false);
});

test('does not parse assets as JavaScript and keeps resolver suffixes', async () => {
    const root = await project({
        'main.ts': "import './asset.txt'; import './real.ts?raw';",
        'asset.txt': "require('this is only text');",
        'real.ts': 'export {};',
    });
    const graph = await analyzeModuleGraph({
        projectRoot: root,
        entryPoints: ['main.ts'],
        resolution: { loader: { '.txt': 'text' } },
    });
    expect(graph.diagnostics).toEqual([]);
    expect(graph.edges.map((edge) => edge.specifier)).toEqual(['./asset.txt', './real.ts?raw']);
    expect(graph.edges[1].resolution).toEqual({ status: 'resolved', path: join(root, 'real.ts'), suffix: '?raw' });
});

test('honors package boundaries, main fields, node platform and extra search paths', async () => {
    const root = await project({
        'main.ts':
            "import 'node:fs'; import 'pkg'; import type { Shape } from 'pkg'; import 'extra'; import type { ExtraShape } from 'extra-types';",
        'node_modules/pkg/package.json':
            '{"main":"server.js","module":"module.js","browser":"browser.js","types":"types.d.ts"}',
        'node_modules/pkg/server.js': 'module.exports = {};',
        'node_modules/pkg/module.js': 'export {};',
        'node_modules/pkg/browser.js': 'export {};',
        'node_modules/pkg/types.d.ts': 'export interface Shape {}',
        'vendor/extra/package.json': '{"main":"index.js"}',
        'vendor/extra/index.js': 'export {};',
        'vendor/extra-types/package.json': '{"exports":{"types":"./types/index.d.ts","default":"./index.js"}}',
        'vendor/extra-types/index.d.ts': 'export interface ExtraShape { unexpected: true; }',
        'vendor/extra-types/index.js': 'export {};',
        'vendor/extra-types/types/index.d.ts': "export interface ExtraShape { nested: import('nested-types').Nested; }",
        'vendor/nested-types/package.json': '{"types":"index.d.ts"}',
        'vendor/nested-types/index.d.ts': 'export interface Nested {}',
    });
    const graph = await analyzeModuleGraph({
        projectRoot: root,
        entryPoints: ['main.ts'],
        resolution: { platform: 'node', mainFields: ['main'], nodePaths: [join(root, 'vendor')] },
    });
    expect(graph.diagnostics).toEqual([]);
    expect(graph.edges.map((edge) => edge.resolution)).toEqual([
        { status: 'external', path: 'node:fs' },
        { status: 'resolved', path: join(root, 'node_modules/pkg/server.js') },
        { status: 'resolved', path: join(root, 'node_modules/pkg/types.d.ts') },
        { status: 'resolved', path: join(root, 'vendor/extra/index.js') },
        { status: 'resolved', path: join(root, 'vendor/extra-types/types/index.d.ts') },
        { status: 'resolved', path: join(root, 'vendor/nested-types/index.d.ts') },
    ]);
    const external = await analyzeModuleGraph({
        projectRoot: root,
        entryPoints: ['main.ts'],
        resolution: { platform: 'node', packages: 'external' },
    });
    expect(external.diagnostics).toEqual([]);
    expect(external.edges.every((edge) => edge.resolution.status === 'external')).toBe(true);
    expect(external.files.map((file) => file.path)).toEqual([join(root, 'main.ts')]);
});

test('resolves type-only aliases and inherited tsconfig paths with discovered and raw configs', async () => {
    const root = await project({
        'tsconfig.json': '{"extends":"./base.json"}',
        'base.json': '{"compilerOptions":{"paths":{"#shape":["./types/shape.d.ts"]}}}',
        'src/main.ts': "import type { Shape } from '#shape'; import type { Alias } from 'alias';",
        'types/shape.d.ts': 'export interface Shape {}',
        'types/alias.d.ts': 'export interface Alias {}',
        'types/alternate.d.ts': 'export interface Shape {}',
    });
    const discovered = await analyzeModuleGraph({
        projectRoot: root,
        entryPoints: ['src/main.ts'],
        resolution: { alias: { alias: './types/alias.d.ts' } },
    });
    expect(discovered.diagnostics).toEqual([]);
    expect(discovered.edges.map((edge) => edge.resolution)).toEqual([
        { status: 'resolved', path: join(root, 'types/shape.d.ts') },
        { status: 'resolved', path: join(root, 'types/alias.d.ts') },
    ]);
    const raw = await analyzeModuleGraph({
        projectRoot: root,
        entryPoints: ['src/main.ts'],
        resolution: {
            alias: { alias: './types/alias.d.ts' },
            tsconfigRaw: { compilerOptions: { paths: { '#shape': ['./types/alternate.d.ts'] } } },
        },
    });
    expect(raw.diagnostics).toEqual([]);
    expect(raw.edges[0].resolution).toEqual({ status: 'resolved', path: join(root, 'types/alternate.d.ts') });
});

test('uses the project tsconfig for declarations imported from dependencies', async () => {
    const root = await project({
        'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true } }),
        'main.ts': "import type { Shape } from 'dependency';",
        'node_modules/dependency/package.json': JSON.stringify({ types: './index.d.ts' }),
        'node_modules/dependency/index.d.ts':
            "import type { Nested } from './nested'; export interface Shape { nested: Nested; }",
        'node_modules/dependency/nested.d.ts': 'export interface Nested {}',
        'node_modules/dependency/tsconfig.json': JSON.stringify({ extends: './missing-base.json' }),
    });
    const graph = await analyzeModuleGraph({ projectRoot: root, entryPoints: ['main.ts'] });
    expect(graph.diagnostics).toEqual([]);
    expect(graph.files).toContainEqual({
        path: join(root, 'node_modules/dependency/index.d.ts'),
        reachability: 'type-only',
    });
    expect(graph.files).toContainEqual({
        path: join(root, 'node_modules/dependency/nested.d.ts'),
        reachability: 'type-only',
    });
});

test('keeps disabled browser modules terminal instead of reading their source', async () => {
    const root = await project({
        'main.ts': "import './disabled';",
        'package.json': '{"browser":{"./disabled.ts":false}}',
        'disabled.ts': "import 'must-not-read';",
    });
    const graph = await analyzeModuleGraph({ projectRoot: root, entryPoints: ['main.ts'] });
    expect(graph.diagnostics).toEqual([]);
    expect(graph.edges[0].resolution).toEqual({ status: 'external', path: join(root, 'disabled') });
    expect(graph.files.map((file) => file.path)).toEqual([join(root, 'main.ts')]);
});

test('checks disabled browser modules per importer directory', async () => {
    const root = await project({
        'main.ts': "import './a/index'; import './b/index';",
        'a/package.json': '{"browser":{"./disabled.ts":false}}',
        'a/index.ts': "import './disabled';",
        'a/disabled.ts': 'export {};',
        'b/index.ts': "import './disabled';",
        'b/disabled.ts': 'export {};',
    });
    const graph = await analyzeModuleGraph({ projectRoot: root, entryPoints: ['main.ts'] });
    const target = (importer: string) =>
        graph.edges.find((edge) => edge.importer === join(root, importer) && edge.specifier === './disabled')
            ?.resolution;
    expect(target('a/index.ts')).toEqual({ status: 'external', path: join(root, 'a/disabled') });
    expect(target('b/index.ts')).toEqual({ status: 'resolved', path: join(root, 'b/disabled.ts') });
});

test('rejects invalid roots, reports malformed source, and keeps other roots available', async () => {
    const root = await project({ 'broken.ts': "import './ok'; const value = ;", 'ok.ts': 'export {};' });
    await expect(analyzeModuleGraph({ projectRoot: root, entryPoints: [] })).rejects.toThrow('At least one');
    await expect(analyzeModuleGraph({ projectRoot: root, entryPoints: ['../outside.ts'] })).rejects.toThrow(
        'project-relative',
    );
    await expect(analyzeModuleGraph({ projectRoot: root, entryPoints: [join(root, 'ok.ts')] })).rejects.toThrow(
        'project-relative',
    );
    const graph = await analyzeModuleGraph({ projectRoot: root, entryPoints: ['broken.ts', 'ok.ts'] });
    expect(graph.diagnostics).toEqual([
        expect.objectContaining({
            code: 'parse-error',
            importer: join(root, 'broken.ts'),
            location: expect.objectContaining({ line: 1 }),
        }),
    ]);
    expect(graph.edges[0].resolution).toEqual({ status: 'resolved', path: join(root, 'ok.ts') });
});

test('keeps runtime resolution failures unresolved even when TypeScript can find a declaration', async () => {
    const root = await project({
        'main.ts': "import 'types-only'; import type { Shape } from 'types-only';",
        'node_modules/types-only/package.json': '{"exports":{"types":"./index.d.ts"}}',
        'node_modules/types-only/index.d.ts': 'export interface Shape {}',
    });
    const graph = await analyzeModuleGraph({ projectRoot: root, entryPoints: ['main.ts'] });
    expect(graph.edges.map((edge) => [edge.kind, edge.resolution])).toEqual([
        ['runtime', { status: 'unresolved' }],
        ['type-only', { status: 'resolved', path: join(root, 'node_modules/types-only/index.d.ts') }],
    ]);
    expect(graph.diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.specifier])).toEqual([
        ['unresolved-import', 'types-only'],
    ]);
});

test('honors symlink identity settings for runtime and type-only paths', async () => {
    const root = await project({
        'main.ts': "import './alias/value'; import type { Shape } from './alias/value';",
        'real/value.ts': 'export interface Shape {}',
    });
    const { symlink } = await import('node:fs/promises');
    await symlink(join(root, 'real'), join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
    const canonical = await analyzeModuleGraph({ projectRoot: root, entryPoints: ['main.ts'] });
    expect(canonical.files).toContainEqual({ path: join(root, 'real/value.ts'), reachability: 'both' });
    const preserved = await analyzeModuleGraph({
        projectRoot: root,
        entryPoints: ['main.ts'],
        resolution: { preserveSymlinks: true },
    });
    expect(preserved.files).toContainEqual({ path: join(root, 'alias/value.ts'), reachability: 'both' });
    expect(preserved.diagnostics).toEqual([]);
});

test('handles every type-only declaration form and literal templates without collecting unrelated calls', async () => {
    const root = await project({
        'main.ts': `import type Default from './shape';
import type * as Shapes from './shape';
import { type Shape } from './shape';
export type { Shape } from './shape';
export { type Shape } from './shape';
export type * as Shapes2 from './shape';
type ShapeModule = typeof import('./shape');
const lazy = import(\`./lazy\`);
const x = object.require('./unrelated');`,
        'shape.ts': 'export default interface Default {} export interface Shape {}',
        'lazy.ts': 'export {};',
    });
    const graph = await analyzeModuleGraph({ projectRoot: root, entryPoints: ['main.ts'] });
    expect(graph.edges.map((edge) => [edge.specifier, edge.kind])).toEqual([
        ['./shape', 'type-only'],
        ['./shape', 'type-only'],
        ['./shape', 'type-only'],
        ['./shape', 'type-only'],
        ['./shape', 'type-only'],
        ['./shape', 'type-only'],
        ['./shape', 'type-only'],
        ['./lazy', 'runtime'],
    ]);
    expect(graph.diagnostics).toEqual([]);
    expect(await analyzeModuleGraph({ projectRoot: root, entryPoints: ['main.ts'] })).toEqual(graph);
});

test('does not treat locally bound require functions as module imports', async () => {
    const root = await project({
        'main.ts': `function local(require: (name: string) => unknown) { require('./not-a-module'); }
function other() { const require = (name: string) => name; require('./also-not-a-module'); }
require('./actual');`,
        'actual.ts': 'export {};',
    });
    const graph = await analyzeModuleGraph({ projectRoot: root, entryPoints: ['main.ts'] });
    expect(graph.edges.map((edge) => edge.specifier)).toEqual(['./actual']);
    expect(graph.diagnostics).toEqual([]);
});

test('uses platform and implicit module conditions when selecting declaration exports', async () => {
    const root = await project({
        'main.ts': "import type { Shape } from 'pkg';",
        'node_modules/pkg/package.json': JSON.stringify({
            exports: {
                browser: { types: './browser.d.ts', default: './browser.js' },
                node: { types: './node.d.ts', default: './node.js' },
                module: { types: './module.d.ts', default: './module.js' },
                default: './default.d.ts',
            },
        }),
        'node_modules/pkg/browser.d.ts': 'export interface Shape {}',
        'node_modules/pkg/node.d.ts': 'export interface Shape {}',
        'node_modules/pkg/module.d.ts': 'export interface Shape {}',
        'node_modules/pkg/default.d.ts': 'export interface Shape {}',
        'node_modules/pkg/browser.js': 'export {};',
        'node_modules/pkg/node.js': 'export {};',
        'node_modules/pkg/module.js': 'export {};',
    });
    const browser = await analyzeModuleGraph({ projectRoot: root, entryPoints: ['main.ts'] });
    expect(browser.edges[0].resolution).toEqual({
        status: 'resolved',
        path: join(root, 'node_modules/pkg/browser.d.ts'),
    });
    const node = await analyzeModuleGraph({
        projectRoot: root,
        entryPoints: ['main.ts'],
        resolution: { platform: 'node' },
    });
    expect(node.edges[0].resolution).toEqual({ status: 'resolved', path: join(root, 'node_modules/pkg/node.d.ts') });
    const module = await analyzeModuleGraph({
        projectRoot: root,
        entryPoints: ['main.ts'],
        resolution: { platform: 'neutral', conditions: ['module'] },
    });
    expect(module.edges[0].resolution).toEqual({
        status: 'resolved',
        path: join(root, 'node_modules/pkg/module.d.ts'),
    });
});

test('rejects invalid resolver configuration instead of silently changing module selection', async () => {
    const root = await project({
        'main.ts': "import type { Shape } from './shape';",
        'shape.ts': 'export interface Shape {}',
        'tsconfig.json': '{"compilerOptions":{"moduleResolution":"not-a-mode"}}',
    });
    await expect(analyzeModuleGraph({ projectRoot: root, entryPoints: ['main.ts'] })).rejects.toThrow(
        'moduleResolution',
    );
});
