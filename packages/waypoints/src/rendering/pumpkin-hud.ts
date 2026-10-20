import type { Player } from 'pumpkin:plugin/player@0.1.0';
import type { OpManager, Server } from 'pumpkin:plugin/server@0.1.0';
import { TextComponent } from 'pumpkin:plugin/text@0.1.0';
import * as uuid from 'pumpkin:plugin/uuid@0.1.0';
import { disposeWasiResource } from '@pumpkin-plugins/plugin-kit/wasi-resource';
import type { WaypointCatalog } from '../waypoints/catalog.ts';
import type { Waypoint } from '../waypoints/model.ts';
import { JAVA_DISPLAY_VERSION } from './java-version.ts';
import { WaypointHudRenderer } from './renderer.ts';

/** Callbacks for viewers the HUD cannot serve. */
export interface WaypointHudServiceOptions {
    /** Called when a viewer's host resource or packet send failed. */
    readonly onError?: (viewerId: string, error: unknown) => void;
    /** Called once per online session for a Java viewer whose client version has no HUD. */
    readonly onUnsupportedVersion?: (viewerId: string, version: string) => void;
}

/** Adapts Pumpkin player events and resources to the per-viewer Java HUD renderer. */
export class WaypointHudService {
    private readonly renderer: WaypointHudRenderer;
    private readonly onError: (viewerId: string, error: unknown) => void;
    private readonly onUnsupportedVersion: (viewerId: string, version: string) => void;
    private readonly unsupportedViewers = new Set<string>();

    constructor(
        private readonly server: Server,
        private readonly catalog: WaypointCatalog,
        options: WaypointHudServiceOptions = {},
    ) {
        this.onError = options.onError ?? (() => undefined);
        this.onUnsupportedVersion = options.onUnsupportedVersion ?? (() => undefined);
        this.renderer = new WaypointHudRenderer({ onError: this.onError });
    }

    /** Reconciles every online Java viewer once per server tick. */
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
            for (const id of this.unsupportedViewers) if (!online.has(id)) this.unsupportedViewers.delete(id);
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

    /** Refreshes the viewer's displays immediately after a player's world changes. */
    changedWorld(player: Player): void {
        this.renderOne(player);
    }

    /** Removes the viewer's client-only displays before their connection closes. */
    left(player: Player): void {
        let java = undefined as ReturnType<Player['asJava']>;
        let id: string | undefined;
        try {
            id = playerKey(player);
            this.unsupportedViewers.delete(id);
            java = player.asJava();
            if (java == null) {
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
                    if (java == null) this.renderer.forgetViewer(id);
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
            this.unsupportedViewers.clear();
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
        opManager: OpManager | undefined,
    ): void {
        let java = undefined as ReturnType<Player['asJava']>;
        let world: ReturnType<Player['getWorld']> | undefined;
        let entity: ReturnType<Player['asEntity']> | undefined;
        try {
            java = player.asJava();
            if (java == null) {
                this.renderer.forgetViewer(id);
                return;
            }
            const version = java.getVersion();
            if (version !== JAVA_DISPLAY_VERSION) {
                this.renderer.removeViewer(id, (packet) => java?.sendPacket(packet));
                if (!this.unsupportedViewers.has(id)) {
                    this.unsupportedViewers.add(id);
                    this.reportUnsupported(id, version);
                }
                return;
            }

            world = player.getWorld();
            entity = player.asEntity();
            const dimension = world.getName();
            const [x, y, z] = player.getPosition();
            const [eyeX, eyeY, eyeZ] = entity.getEyePosition();
            const uuidValue = player.getId();
            // Restricted waypoints often share a grant, and each check is a host call.
            const permissions = new Map<string, boolean>();
            const hasPermission = (node: string): boolean => {
                let allowed = permissions.get(node);
                if (allowed === undefined) {
                    allowed = player.hasPermission(node);
                    permissions.set(node, allowed);
                }
                return allowed;
            };
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
                    eyePosition: { x: eyeX, y: eyeY, z: eyeZ },
                    yaw: player.getYaw(),
                    pitch: player.getPitch(),
                    isOperator,
                    hasPermission,
                    createEntityUuid: uuid.generate,
                    encodeTextComponent,
                    sendPacket: (packet) => java?.sendPacket(packet),
                },
                waypoints.get(dimension) ?? [],
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

    private reportUnsupported(viewerId: string, version: string): void {
        try {
            this.onUnsupportedVersion(viewerId, version);
        } catch {
            // Logging must not stop another viewer's HUD from updating.
        }
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
