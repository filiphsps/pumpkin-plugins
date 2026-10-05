/** A whole-block coordinate for a temporary client light. */
export interface BlockPosition {
    x: number;
    y: number;
    z: number;
}

/** The player operations needed to show and clear a client-only light block. */
export interface LightClient {
    /** Shows a temporary block state without changing the server world. */
    sendBlockChange(position: BlockPosition, stateId: number): void;

    /** Shows the actual server block again at this position. */
    resetBlockChange(position: BlockPosition): void;
}

/** Finds an air cell at or just above a player's block position for a fake light. */
export function findLightPosition(
    position: BlockPosition,
    isAir: (position: BlockPosition) => boolean
): BlockPosition | undefined {
    for (let offset = 0; offset <= 2; offset += 1) {
        const candidate = { x: position.x, y: position.y + offset, z: position.z };
        if (isAir(candidate)) return candidate;
    }
    return undefined;
}

interface ClientLight {
    readonly position: BlockPosition;
    readonly stateId: number;
}

/** A light source contributing to a viewer's client block. */
export interface PositionedLight {
    readonly position: BlockPosition;
    readonly level: number;
}

interface ViewerLights {
    readonly sources: Map<string, readonly PositionedLight[]>;
    cells: Map<string, ClientLight>;
}

/** Builds the invisible Minecraft light states used only in client packets. */
export function clientLightStates(
    resolveState: (blockName: string, properties: [string, string][]) => number | undefined
): ((level: number) => number) | undefined {
    const states = new Map<number, number>();
    for (let level = 1; level <= 15; level += 1) {
        const stateId = resolveState('minecraft:light', [['level', String(level)]]);
        if (stateId === undefined) return undefined;
        states.set(level, stateId);
    }
    const fallback = states.get(1);
    if (fallback === undefined) return undefined;
    return (level) => states.get(level) ?? fallback;
}

/** Maintains client-only light blocks without ever changing the server world. */
export class ClientLightTracker {
    private readonly viewers = new Map<string, ViewerLights>();

    constructor(private readonly stateForLevel: (level: number) => number) {}

    /** Updates one player's temporary light, or clears it when the light level is zero. */
    sync(playerId: string, client: LightClient, position: BlockPosition, level: number): void {
        this.replaceSources(playerId, client, 'held', level > 0 ? [{ position, level }] : []);
    }

    /** Reconciles one source group, keeping the brightest source in every occupied cell. */
    replaceSources(playerId: string, client: LightClient, group: string, sources: readonly PositionedLight[]): void {
        const viewer = this.viewers.get(playerId) ?? { sources: new Map(), cells: new Map() };
        if (sources.length === 0) viewer.sources.delete(group);
        else
            viewer.sources.set(
                group,
                sources.map(({ position, level }) => ({ position: { ...position }, level }))
            );

        const levels = new Map<string, PositionedLight>();
        for (const groupSources of viewer.sources.values()) {
            for (const source of groupSources) {
                if (source.level <= 0) continue;
                const key = positionKey(source.position);
                if ((levels.get(key)?.level ?? 0) < source.level) levels.set(key, source);
            }
        }
        const cells = new Map<string, ClientLight>();
        for (const [key, source] of levels) {
            cells.set(key, { position: source.position, stateId: this.stateForLevel(source.level) });
        }
        for (const [key, previous] of viewer.cells) {
            if (!cells.has(key)) client.resetBlockChange(previous.position);
        }
        for (const [key, light] of cells) {
            if (viewer.cells.get(key)?.stateId !== light.stateId) client.sendBlockChange(light.position, light.stateId);
        }
        viewer.cells = cells;
        if (viewer.sources.size === 0) this.viewers.delete(playerId);
        else this.viewers.set(playerId, viewer);
    }

    /** Clears one player's temporary client light. */
    remove(playerId: string, client: LightClient): void {
        this.replaceSources(playerId, client, 'held', []);
    }

    /** Restores all client blocks for a player who disables lights or unloads the plugin. */
    reset(playerId: string, client: LightClient): void {
        for (const light of this.viewers.get(playerId)?.cells.values() ?? []) client.resetBlockChange(light.position);
        this.forget(playerId);
    }

    /** Forgets a previous client world without sending its block positions into the new world. */
    forget(playerId: string): void {
        this.viewers.delete(playerId);
    }

    /** Forgets all temporary client lights when the server unloads the plugin. */
    clear(): void {
        this.viewers.clear();
    }
}

function positionKey({ x, y, z }: BlockPosition): string {
    return `${x}:${y}:${z}`;
}
