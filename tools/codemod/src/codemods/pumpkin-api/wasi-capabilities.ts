import * as path from 'node:path';
import { type AnalysisDiagnostic, analyzeModuleGraph, type ModuleGraph } from '@pumpkin-plugins/static-analysis';
import { type Capability, capabilitiesForInterface, EXTERNAL_MODULES } from '@pumpkin-plugins/wasi-capabilities';
import { normalizePackagePath } from './package-path.ts';

/** Capabilities found in a production graph and any limits that need user review. */
export interface WasiCapabilityInference {
    analyzed: boolean;
    capabilities: Capability[];
    messages: string[];
}

/** Analyzes only the configured production entry with the builder's external-module boundaries. */
export async function inferWasiCapabilities(projectRoot: string, entry: string): Promise<WasiCapabilityInference> {
    const normalizedEntry = normalizePackagePath(entry);
    if (!normalizedEntry) {
        return {
            analyzed: false,
            capabilities: [],
            messages: [
                'Could not analyze pumpkinPlugin.entry because it is not a package-relative path; the existing wasi value was preserved.',
            ],
        };
    }

    let graph: ModuleGraph;
    try {
        graph = await analyzeModuleGraph({
            projectRoot,
            entryPoints: [normalizedEntry],
            resolution: { external: [...EXTERNAL_MODULES], platform: 'browser' },
        });
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return {
            analyzed: false,
            capabilities: [],
            messages: [
                `Could not analyze pumpkinPlugin.entry ${JSON.stringify(entry)}: ${detail}; the existing wasi value was preserved.`,
            ],
        };
    }

    const root = graph.roots[0];
    if (root?.resolution.status !== 'resolved') {
        const messages = graph.diagnostics.map((diagnostic) => formatAnalysisDiagnostic(diagnostic, projectRoot));
        messages.push(
            `Could not resolve pumpkinPlugin.entry ${JSON.stringify(entry)}; WASI inference was skipped and the existing wasi value was preserved.`,
        );
        return { analyzed: false, capabilities: [], messages: [...new Set(messages)] };
    }

    const reachableFiles = new Set(graph.files.map(({ path: filePath }) => filePath));
    if (!reachableFiles.has(root.resolution.path)) {
        const messages = graph.diagnostics.map((diagnostic) => formatAnalysisDiagnostic(diagnostic, projectRoot));
        messages.push(
            `Could not read the configured production entry ${JSON.stringify(entry)}; WASI inference was skipped and the existing wasi value was preserved.`,
        );
        return { analyzed: false, capabilities: [], messages: [...new Set(messages)] };
    }

    const messages = graph.diagnostics.map((diagnostic) => formatAnalysisDiagnostic(diagnostic, projectRoot));
    const capabilities = new Set<Capability>();
    const ambiguous = new Map<string, Capability[]>();
    for (const edge of graph.edges) {
        if (!reachableFiles.has(edge.importer) || !edge.specifier?.startsWith('wasi:')) continue;
        const interfacePath = wasiInterfacePath(edge.specifier);
        if (!interfacePath) {
            messages.push(
                `Could not identify the WASI interface in ${JSON.stringify(edge.specifier)} from ${formatLocation(edge.importer, edge.location, projectRoot)}; other interfaces were still analyzed.`,
            );
            continue;
        }

        const matches = capabilitiesForInterface(interfacePath);
        if (matches.length === 1) {
            const capability = matches[0];
            if (capability) capabilities.add(capability);
        } else if (matches.length > 1) {
            ambiguous.set(interfacePath, matches);
        } else {
            messages.push(
                `WASI interface ${JSON.stringify(interfacePath)} has no builder capability mapping; review pumpkinPlugin.wasi.`,
            );
        }
    }

    for (const [interfacePath, matches] of ambiguous) {
        if (matches.some((capability) => capabilities.has(capability))) continue;
        messages.push(
            `WASI interface ${JSON.stringify(interfacePath)} is shared by ${matches.join(', ')}; no capability was inferred for it. Review pumpkinPlugin.wasi.`,
        );
    }

    return {
        analyzed: true,
        capabilities: [...capabilities].sort(),
        messages: [...new Set(messages)],
    };
}

/** Removes the WASI namespace and optional interface version from an import specifier. */
function wasiInterfacePath(specifier: string): string | undefined {
    const value = specifier.slice('wasi:'.length);
    const versionIndex = value.lastIndexOf('@');
    const interfacePath = versionIndex > 0 ? value.slice(0, versionIndex) : value;
    return interfacePath.includes('/') ? interfacePath : undefined;
}

/** Formats one analyzer diagnostic as a package-manifest review note. */
function formatAnalysisDiagnostic(diagnostic: AnalysisDiagnostic, projectRoot: string): string {
    const location = formatLocation(diagnostic.importer, diagnostic.location, projectRoot);
    const specifier = diagnostic.specifier === undefined ? '' : ` ${JSON.stringify(diagnostic.specifier)}`;
    switch (diagnostic.code) {
        case 'nonliteral-import':
            return `Could not infer capabilities from a computed ${diagnostic.form ?? 'import'}${specifier} at ${location}; other resolved WASI imports were still analyzed.`;
        case 'unresolved-import':
            return `Could not resolve${specifier} from ${location}; other resolved WASI imports were still analyzed.`;
        case 'unresolved-entry':
            return `Could not resolve the production entry${specifier} at ${location}: ${diagnostic.message}`;
        case 'unreadable-file':
            return `Could not read ${location}; the WASI analysis may be incomplete.`;
        case 'parse-error':
            return `Could not fully parse ${location}; the WASI analysis may be incomplete.`;
    }
}

/** Formats a project-relative source location for migration notes. */
function formatLocation(importer: string, location: { line: number; column: number }, projectRoot: string): string {
    const relativePath = path.relative(projectRoot, importer).split(path.sep).join('/');
    return `${relativePath || path.basename(importer)}:${location.line}:${location.column}`;
}
