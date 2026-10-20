import type { PluginBuild } from 'esbuild';
import { reachableFiles } from './graph.ts';
import { dependencies } from './parse.ts';
import { type BrowserProbeCache, resolveDependency } from './resolve.ts';
import { readSource } from './source.ts';
import { typeResolver } from './type-resolution.ts';
import type { AnalyzeModuleGraphOptions, ModuleGraph } from './types.ts';

/** Collects source dependencies before computing reachability across all resolved roots. */
export async function collectGraph(
    builder: PluginBuild,
    graph: ModuleGraph,
    options: AnalyzeModuleGraphOptions,
    projectRoot: string,
    entries: string[],
): Promise<void> {
    const settings = options.resolution ?? {};
    const queue: string[] = [];
    for (const [index, entry] of entries.entries()) {
        const result = await builder.resolve(entry, {
            kind: 'entry-point',
            resolveDir: projectRoot,
        });
        const resolution = result.errors.length
            ? { status: 'unresolved' as const }
            : { status: 'resolved' as const, path: result.path };
        graph.roots.push({ entryPoint: options.entryPoints[index], resolution });
        if (resolution.status === 'resolved') queue.push(resolution.path);
        else
            graph.diagnostics.push({
                code: 'unresolved-entry',
                importer: entry,
                specifier: options.entryPoints[index],
                location: { line: 1, column: 1, offset: 0, length: 0 },
                message: result.errors.map((error) => error.text).join('\n'),
            });
    }
    const seen = new Set<string>();
    const resolveType = typeResolver(projectRoot, settings);
    const probes: BrowserProbeCache = new Map();
    for (const file of queue) {
        if (seen.has(file)) continue;
        seen.add(file);
        const source = await readSource(file, settings, graph.diagnostics);
        if (!source) continue;
        const resolved = await Promise.all(
            dependencies(source.source, source.checker).map(async (dependency) => {
                const specifier = dependency.specifier;
                if (specifier === undefined) return { dependency };
                const require = dependency.form === 'require' || dependency.form === 'import-equals';
                const result = await resolveDependency(
                    builder,
                    projectRoot,
                    settings,
                    probes,
                    file,
                    specifier,
                    require
                        ? 'require-call'
                        : dependency.form === 'dynamic-import'
                          ? 'dynamic-import'
                          : 'import-statement',
                );
                const typePath =
                    dependency.kind === 'type-only' && !result.external
                        ? resolveType(specifier, file, require)
                        : undefined;
                return { dependency, specifier, result, typePath };
            }),
        );
        for (const { dependency, specifier, result, typePath } of resolved) {
            if (!result) {
                graph.edges.push({ ...dependency, resolution: { status: 'unresolved' } });
                graph.diagnostics.push({
                    ...dependency,
                    code: 'nonliteral-import',
                    message: 'Import target is not a string literal; no target was guessed.',
                });
                continue;
            }
            const resolution = result.external
                ? { status: 'external' as const, path: result.path }
                : typePath
                  ? { status: 'resolved' as const, path: typePath }
                  : result.errors.length
                    ? { status: 'unresolved' as const }
                    : {
                          status: 'resolved' as const,
                          path: result.path,
                          ...(result.suffix ? { suffix: result.suffix } : {}),
                      };
            graph.edges.push({ ...dependency, resolution });
            if (resolution.status === 'unresolved')
                graph.diagnostics.push({
                    ...dependency,
                    code: 'unresolved-import',
                    message: result.errors.map((error) => error.text).join('\n') || `Could not resolve ${specifier}`,
                });
            if (resolution.status === 'resolved') queue.push(resolution.path);
        }
    }
    graph.files = reachableFiles(graph);
}
