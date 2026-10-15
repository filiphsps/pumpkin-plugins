/** Describes one PumpkinPIE placeholder provided by Distant Horizons Support. */
export interface DhsPlaceholderDefinition {
    readonly description: string;
    readonly name: string;
}

export const dhsPlaceholderDefinitions = [
    {
        name: 'client_connected',
        description: 'Whether the supplied viewer has an active Distant Horizons session.',
    },
    { name: 'clients', description: 'Number of active Distant Horizons client sessions.' },
    { name: 'pending_requests', description: 'Number of pending LOD requests.' },
    { name: 'worker_ticks', description: 'Number of Distant Horizons worker ticks processed.' },
    { name: 'served', description: 'Number of LOD requests served.' },
    { name: 'rejected', description: 'Number of LOD requests rejected.' },
    { name: 'cancelled', description: 'Number of LOD requests cancelled.' },
    { name: 'packet_bytes_sent', description: 'Cumulative Distant Horizons packet bytes sent.' },
    { name: 'cache_refreshes', description: 'Number of current background cache refreshes.' },
    { name: 'memory_entries', description: 'Number of entries in the memory cache.' },
    { name: 'memory_bytes', description: 'Sum of cached LOD payload byte lengths in memory.' },
    { name: 'memory_limit', description: 'Configured memory cache entry limit; -1 means unlimited.' },
    { name: 'disk_entries', description: 'Number of entries indexed in the disk cache.' },
    { name: 'disk_bytes', description: 'Bytes indexed in the disk cache.' },
    { name: 'disk_limit', description: 'Configured disk cache entry limit; -1 means unlimited.' },
] as const satisfies readonly DhsPlaceholderDefinition[];

/** One local placeholder name accepted by the `dhs` namespace. */
export type DhsPlaceholderName = (typeof dhsPlaceholderDefinitions)[number]['name'];

/** Local placeholder names advertised without the `dhs_` namespace prefix. */
export const dhsPlaceholderNames: readonly DhsPlaceholderName[] = dhsPlaceholderDefinitions.map(({ name }) => name);
