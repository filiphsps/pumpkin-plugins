import { isAbsolute, relative, resolve, sep } from 'node:path';
import { build } from 'esbuild';
import { collectGraph } from './collect.ts';
import type { AnalyzeModuleGraphOptions, ModuleGraph } from './types.ts';

export type {
    AnalysisDiagnostic,
    AnalyzeModuleGraphOptions,
    EdgeKind,
    ImportForm,
    ModuleEdge,
    ModuleFile,
    ModuleGraph,
    ModuleResolution,
    ResolutionSettings,
    SourceLocation,
} from './types.ts';

/**
 * Reads the combined reachable source graph without evaluating project modules.
 *
 * @throws When roots escape the project, no roots are supplied, or resolver settings are invalid.
 */
export async function analyzeModuleGraph(options: AnalyzeModuleGraphOptions): Promise<ModuleGraph> {
    const projectRoot = resolve(options.projectRoot);
    if (!options.entryPoints.length) throw new Error('At least one project-relative entry point is required.');
    const entries = options.entryPoints.map((entry) => {
        const path = resolve(projectRoot, entry);
        const fromRoot = relative(projectRoot, path);
        if (isAbsolute(entry) || fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) {
            throw new Error(`Entry point must be project-relative and inside the project: ${entry}`);
        }
        return path;
    });
    const graph: ModuleGraph = { roots: [], files: [], edges: [], diagnostics: [] };
    await build({
        ...options.resolution,
        absWorkingDir: projectRoot,
        bundle: true,
        write: false,
        logLevel: 'silent',
        stdin: { contents: '', resolveDir: projectRoot },
        plugins: [
            {
                name: 'static-module-graph',
                setup(builder) {
                    builder.onStart(async () => {
                        await collectGraph(builder, graph, options, projectRoot, entries);
                    });
                },
            },
        ],
    });
    return graph;
}
