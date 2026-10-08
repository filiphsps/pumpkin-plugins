import type { Player } from 'pumpkin:plugin/player@0.1.0';
import type { OpManager, Server } from 'pumpkin:plugin/server@0.1.0';
import { TextComponent } from 'pumpkin:plugin/text@0.1.0';
import * as uuid from 'pumpkin:plugin/uuid@0.1.0';
import { disposeWasiResource } from '@pumpkin-plugins/plugin-kit/wasi-resource';
import type { WaypointCatalog } from '../waypoints/catalog.ts';
import type { Waypoint } from '../waypoints/model.ts';
import { WaypointHudRenderer } from './renderer.ts';

/** Error reporting for a viewer whose host resource or packet send failed. */
export interface WaypointHudServiceOptions {
    readonly onError?: (viewerId: string, error: unknown) => void;
}

/** Adapts Pumpkin player events and resources to the per-viewer Java HUD renderer. */
export class WaypointHudService {
    private readonly renderer: WaypointHudRenderer;
    private readonly onError: (viewerId: string, error: unknown) => void;

    constructor(
        private readonly server: Server,
        private readonly catalog: WaypointCatalog,
        options: WaypointHudServiceOptions = {}
    ) {
        this.onError = options.onError ?? (() => undefined);
        this.renderer = new WaypointHudRenderer({ onError: this.onError });
    }

    /** Reconciles every online Java 26.3 viewer once per server tick. */
    tick(): void {
        const waypoints = this.groupByDimension(this.catalog.list());
        let opManager: OpManager | undefined;
        try {
            opManager = this.server.getOpManager();
        } catch (error) {
            this.report('*', error);
        }

        const online = new Set<string>();
        try {
            for (const player of this.server.getAllPlayers()) {
                try {
                    const id = playerKey(player);
                    online.add(id);
                    this.renderPlayer(player, id, waypoints, opManager);
                } catch (error) {
                    this.report('*', error);
                } finally {
                    disposeWasiResource(player);
                }
            }
            this.renderer.retainViewers(online);
        } catch (error) {
            this.report('*', error);
        } finally {
            disposeWasiResource(opManager);
        }
    }

    /** Starts a joining player's HUD without waiting for the next tick. */
    joined(player: Player): void {
        this.renderOne(player);
    }

    /** Reprojects the HUD immediately after a player's world changes. */
    changedWorld(player: Player): void {
        this.renderOne(player);
    }

    /** Removes the viewer's client-only displays before their connection closes. */
    left(player: Player): void {
        let java = undefined as ReturnType<Player['asJava']>;
        let id: string | undefined;
        try {
            id = playerKey(player);
            java = player.asJava();
            if (java === undefined) {
                this.renderer.forgetViewer(id);
                return;
            }
            this.renderer.removeViewer(id, (packet) => java?.sendPacket(packet));
        } catch (error) {
            if (id !== undefined) this.report(id, error);
        } finally {
            disposeWasiResource(java);
        }
    }

    /** Sends removal packets to online clients and drops all transient renderer state. */
    unload(): void {
        try {
            for (const player of this.server.getAllPlayers()) {
                let java = undefined as ReturnType<Player['asJava']>;
                try {
                    const id = playerKey(player);
                    java = player.asJava();
                    if (java === undefined) this.renderer.forgetViewer(id);
                    else this.renderer.removeViewer(id, (packet) => java?.sendPacket(packet));
                } catch (error) {
                    this.report('*', error);
                } finally {
                    disposeWasiResource(java);
                    disposeWasiResource(player);
                }
            }
        } catch (error) {
            this.report('*', error);
        } finally {
            this.renderer.clear();
        }
    }

    private renderOne(player: Player): void {
        let opManager: OpManager | undefined;
        try {
            opManager = this.server.getOpManager();
        } catch (error) {
            this.report('*', error);
        }
        try {
            this.renderPlayer(player, playerKey(player), this.groupByDimension(this.catalog.list()), opManager);
        } catch (error) {
            this.report('*', error);
        } finally {
            disposeWasiResource(opManager);
        }
    }

    private renderPlayer(
        player: Player,
        id: string,
        waypoints: ReadonlyMap<string, readonly Waypoint[]>,
        opManager: OpManager | undefined
    ): void {
        let java = undefined as ReturnType<Player['asJava']>;
        let world: ReturnType<Player['getWorld']> | undefined;
        let entity: ReturnType<Player['asEntity']> | undefined;
        try {
            java = player.asJava();
            if (java === undefined) {
                this.renderer.forgetViewer(id);
                return;
            }
            if (java.getVersion() !== 'v-26-3') {
                this.renderer.removeViewer(id, (packet) => java?.sendPacket(packet));
                return;
            }

            world = player.getWorld();
            entity = player.asEntity();
            const dimension = world.getName();
            const [x, y, z] = player.getPosition();
            const [eyeX, eyeY, eyeZ] = entity.getEyePosition();
            const uuidValue = player.getId();
            let isOperator = false;
            try {
                isOperator = opManager?.isOp(uuidValue) ?? false;
            } catch (error) {
                this.report(id, error);
            }
            this.renderer.renderViewer(
                {
                    id,
                    dimension,
                    position: { x, y, z },
                    camera: {
                        position: { x: eyeX, y: eyeY, z: eyeZ },
                        yaw: player.getYaw(),
                        pitch: player.getPitch()
                    },
                    isOperator,
                    hasPermission: (node) => player.hasPermission(node),
                    createEntityUuid: uuid.generate,
                    encodeTextComponent,
                    sendPacket: (packet) => java?.sendPacket(packet)
                },
                waypoints.get(dimension) ?? []
            );
        } finally {
            disposeWasiResource(entity);
            disposeWasiResource(world);
            disposeWasiResource(java);
        }
    }

    private groupByDimension(waypoints: readonly Waypoint[]): Map<string, Waypoint[]> {
        const grouped = new Map<string, Waypoint[]>();
        for (const waypoint of waypoints) {
            const group = grouped.get(waypoint.dimension);
            if (group === undefined) grouped.set(waypoint.dimension, [waypoint]);
            else group.push(waypoint);
        }
        return grouped;
    }

    private report(viewerId: string, error: unknown): void {
        try {
            this.onError(viewerId, error);
        } catch {
            // Error reporting must not stop another viewer's HUD from updating.
        }
    }
}

function playerKey(player: Player): string {
    return uuid.toString(player.getId()).toLowerCase();
}

function encodeTextComponent(json: string): Uint8Array {
    let component: TextComponent | undefined;
    try {
        component = TextComponent.fromJson(json);
        return component.encode();
    } finally {
        disposeWasiResource(component);
    }
}
