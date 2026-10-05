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
    private readonly lights = new Map<string, ClientLight>();

    constructor(private readonly stateForLevel: (level: number) => number) {}

    /** Updates one player's temporary light, or clears it when the light level is zero. */
    sync(playerId: string, client: LightClient, position: BlockPosition, level: number): void {
        const current = this.lights.get(playerId);
        if (level === 0) {
            this.remove(playerId, client);
            return;
        }

        const stateId = this.stateForLevel(level);
        if (
            current?.position.x === position.x &&
            current.position.y === position.y &&
            current.position.z === position.z
        ) {
            if (current.stateId !== stateId) {
                client.sendBlockChange(position, stateId);
                this.lights.set(playerId, { position: { ...position }, stateId });
            }
            return;
        }

        if (current !== undefined) {
            client.resetBlockChange(current.position);
        }
        client.sendBlockChange(position, stateId);
        this.lights.set(playerId, { position: { ...position }, stateId });
    }

    /** Clears one player's temporary client light. */
    remove(playerId: string, client: LightClient): void {
        const current = this.lights.get(playerId);
        if (current === undefined) return;
        client.resetBlockChange(current.position);
        this.lights.delete(playerId);
    }

    /** Forgets all temporary client lights when the server unloads the plugin. */
    clear(): void {
        this.lights.clear();
    }
}
