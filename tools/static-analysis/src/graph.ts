import type { EdgeKind, ModuleGraph } from './types.ts';

/** Propagates both path classes to a fixed point, including cycles and shared roots. */
export function reachableFiles(graph: ModuleGraph): ModuleGraph['files'] {
    const outgoing = new Map<string, typeof graph.edges>();
    for (const edge of graph.edges) {
        const edges = outgoing.get(edge.importer) ?? [];
        edges.push(edge);
        outgoing.set(edge.importer, edges);
    }
    const reached = new Map<string, Set<EdgeKind>>();
    const queue: { path: string; kind: EdgeKind }[] = [];
    for (const root of graph.roots) {
        if (root.resolution.status === 'resolved') queue.push({ path: root.resolution.path, kind: 'runtime' });
    }
    for (const { path, kind } of queue) {
        const kinds = reached.get(path) ?? new Set<EdgeKind>();
        if (kinds.has(kind)) continue;
        kinds.add(kind);
        reached.set(path, kinds);
        for (const edge of outgoing.get(path) ?? []) {
            if (edge.resolution.status === 'resolved') {
                queue.push({ path: edge.resolution.path, kind: kind === 'type-only' ? kind : edge.kind });
            }
        }
    }
    return [...reached].map(([path, kinds]) => ({
        path,
        reachability: kinds.size === 2 ? 'both' : kinds.has('runtime') ? 'runtime' : 'type-only',
    }));
}
