import type { Player } from 'pumpkin:plugin/player@0.1.0';
import type { Server } from 'pumpkin:plugin/server@0.1.0';
import { type RgbColor, TextComponent } from 'pumpkin:plugin/text@0.1.0';
import * as uuid from 'pumpkin:plugin/uuid@0.1.0';
import { disposeWasiResource } from '@pumpkin-plugins/plugin-kit/wasi-resource';
import { type ApplyResult, JAVA_DISPLAY_VERSION, type PlayerSnapshot, type RenderedLine } from '../model.ts';
import type { TabDisplayHost } from '../service.ts';

/** Java client version currently allowed through the adapter gate. */
export { JAVA_DISPLAY_VERSION };

/** Unsupported reason while the native Java client ordering direction lacks a live probe. */
export const SORT_DIRECTION_UNVERIFIED = 'Native Java tab order direction is not verified on a client.';

/** Options gated by an observed Java client contract. */
export interface JavaTabDisplayHostOptions {
    /** Java clients display lower order values first. Keep unset until a client probe proves this. */
    readonly orderDirection?: 'ascending' | 'descending';
}

interface ActivePlayer {
    readonly player: Player;
    readonly snapshot: PlayerSnapshot;
}

interface NameOwnership {
    lastAppliedJson: string;
    readonly originalJson: string | undefined;
}

/** WIT-backed Java display adapter with per-tick resource ownership. */
export class JavaTabDisplayHost implements TabDisplayHost {
    private server: Server | undefined;
    private activePlayers = new Map<string, ActivePlayer>();
    private activeResources: Player[] = [];
    private readonly nameOwnership = new Map<string, NameOwnership>();
    private readonly headerOwnership = new Set<string>();
    private readonly orderOwnership = new Set<string>();

    constructor(private readonly options: JavaTabDisplayHostOptions = {}) {}

    /** Supplies the server handle only for the duration of one scheduled callback. */
    setServer(server: Server): void {
        this.server = server;
    }

    /** Drops the transient server handle after one scheduled callback. */
    clearServer(): void {
        this.server = undefined;
    }

    /** Releases player resources and the server handle before the callback returns. */
    endTick(): void {
        this.releaseActivePlayers();
        this.clearServer();
    }

    /** Copies at most `limit + 1` snapshots; the extra record reports capacity overflow. */
    snapshotPlayers(limit: number): readonly PlayerSnapshot[] {
        this.releaseActivePlayers();
        if (this.server === undefined) throw new Error('No server handle is active for this tick');

        const players = this.server.getAllPlayers();
        this.activeResources = players;
        try {
            const count = Math.min(players.length, limit + 1);
            const snapshots: PlayerSnapshot[] = [];
            const active = new Map<string, ActivePlayer>();
            for (let index = 0; index < count; index += 1) {
                const player = players[index];
                if (player === undefined) continue;
                const snapshot = readPlayer(player);
                snapshots.push(snapshot);
                active.set(snapshot.uuid, { player, snapshot });
            }

            if (players.length > limit) {
                const currentIds = new Set(players.map((player) => uuid.toString(player.getId())));
                this.retainOwnership(currentIds);
                this.releaseActivePlayers();
                return snapshots;
            }

            this.activePlayers = active;
            this.retainOwnership(new Set(active.keys()));
            return snapshots;
        } catch (error) {
            this.releaseActivePlayers();
            throw error;
        }
    }

    /** Applies a literal styled custom tab row name on supported Java clients. */
    setEntryName(uuidValue: string, value: RenderedLine | undefined): ApplyResult {
        const active = this.activePlayers.get(uuidValue);
        if (active === undefined) return { kind: 'failed', error: 'Player is not in the current display snapshot' };
        const supported = javaDisplaySupport(active.snapshot);
        if (supported.kind === 'unsupported') return supported;
        if (active.snapshot.edition !== 'java') return bedrockUnsupported('row names');

        const owner = this.nameOwnership.get(uuidValue);
        let currentJson: string | undefined;
        try {
            currentJson = readTabName(active.player);
        } catch {
            return { kind: 'failed', error: 'Could not read the current tab row name' };
        }

        if (owner !== undefined && currentJson !== owner.lastAppliedJson) {
            this.nameOwnership.delete(uuidValue);
            return { kind: 'failed', error: 'Tab row name changed outside TabDisplay; ownership released' };
        }

        if (value === undefined) {
            if (owner === undefined) return { kind: 'unchanged' };
            return this.restoreName(active.player, uuidValue, owner);
        }

        let component: TextComponent | undefined;
        try {
            component = styledText(value);
            const nextJson = component.toJson();
            if (currentJson === nextJson) return { kind: 'unchanged' };
            active.player.setTabListName(component);
            this.nameOwnership.set(uuidValue, {
                originalJson: owner === undefined ? currentJson : owner.originalJson,
                lastAppliedJson: nextJson,
            });
            return { kind: 'applied' };
        } catch {
            return { kind: 'failed', error: 'Could not apply the Java tab row name' };
        } finally {
            disposeWasiResource(component);
        }
    }

    /** Applies one native order value only after protocol support and direction are verified. */
    setOrder(uuidValue: string, order: number): ApplyResult {
        const active = this.activePlayers.get(uuidValue);
        if (active === undefined) return { kind: 'failed', error: 'Player is not in the current display snapshot' };
        if (active.snapshot.edition !== 'java') return bedrockUnsupported('row ordering');
        if (!supportsNativeOrder(active.snapshot.javaVersion)) {
            return { kind: 'unsupported', reason: 'Native Java tab ordering requires client protocol 1.21.2 or later' };
        }
        if (this.options.orderDirection === undefined)
            return { kind: 'unsupported', reason: SORT_DIRECTION_UNVERIFIED };
        if (!Number.isSafeInteger(order) || order < 0 || order > 2_147_483_647)
            return { kind: 'failed', error: 'Tab order exceeds signed-32-bit range' };

        const nativeOrder = this.options.orderDirection === 'ascending' ? order : -order;
        try {
            active.player.setTabListOrder(nativeOrder);
            this.orderOwnership.add(uuidValue);
            return { kind: 'applied' };
        } catch {
            return { kind: 'failed', error: 'Could not apply the Java tab row order' };
        }
    }

    /** Applies viewer-specific header and footer text without calling Java-only fields on Bedrock. */
    setHeaderFooter(uuidValue: string, header: readonly RenderedLine[], footer: readonly RenderedLine[]): ApplyResult {
        const active = this.activePlayers.get(uuidValue);
        if (active === undefined) return { kind: 'failed', error: 'Player is not in the current display snapshot' };
        const supported = javaDisplaySupport(active.snapshot);
        if (supported.kind === 'unsupported') return supported;
        if (active.snapshot.edition !== 'java') return bedrockUnsupported('header and footer');

        let headerComponent: TextComponent | undefined;
        let footerComponent: TextComponent | undefined;
        try {
            headerComponent = styledLines(header);
            footerComponent = styledLines(footer);
            active.player.setTabListHeaderFooter(headerComponent, footerComponent);
            this.headerOwnership.add(uuidValue);
            return { kind: 'applied' };
        } catch {
            return { kind: 'failed', error: 'Could not apply Java tab header and footer' };
        } finally {
            disposeWasiResource(headerComponent);
            disposeWasiResource(footerComponent);
        }
    }

    /** Restores only owned names; order resets to the pinned API's default zero, headers clear. */
    resetOwned(uuidValue: string): void {
        const active = this.activePlayers.get(uuidValue);
        if (active === undefined) {
            this.dropOwnership(uuidValue);
            return;
        }

        const owner = this.nameOwnership.get(uuidValue);
        if (owner !== undefined) {
            const result = this.restoreName(active.player, uuidValue, owner);
            if (result.kind === 'failed') throw new Error(result.error);
        }

        if (this.headerOwnership.has(uuidValue)) {
            const emptyHeader = TextComponent.text('');
            const emptyFooter = TextComponent.text('');
            try {
                active.player.setTabListHeaderFooter(emptyHeader, emptyFooter);
                this.headerOwnership.delete(uuidValue);
            } finally {
                disposeWasiResource(emptyHeader);
                disposeWasiResource(emptyFooter);
            }
        }

        if (this.orderOwnership.has(uuidValue)) {
            active.player.setTabListOrder(0);
            this.orderOwnership.delete(uuidValue);
        }
    }

    private restoreName(player: Player, uuidValue: string, owner: NameOwnership): ApplyResult {
        let currentJson: string | undefined;
        try {
            currentJson = readTabName(player);
        } catch {
            return { kind: 'failed', error: 'Could not verify TabDisplay row-name ownership' };
        }
        if (currentJson !== owner.lastAppliedJson) {
            this.nameOwnership.delete(uuidValue);
            return { kind: 'unchanged' };
        }

        let original: TextComponent | undefined;
        try {
            // This JSON is a copied, host-owned component captured before TabDisplay took ownership.
            original = owner.originalJson === undefined ? undefined : TextComponent.fromJson(owner.originalJson);
            player.setTabListName(original);
            this.nameOwnership.delete(uuidValue);
            return { kind: 'applied' };
        } catch {
            return { kind: 'failed', error: 'Could not restore the original Java tab row name' };
        } finally {
            disposeWasiResource(original);
        }
    }

    private releaseActivePlayers(): void {
        for (const player of this.activeResources) disposeWasiResource(player);
        this.activeResources = [];
        this.activePlayers.clear();
    }

    private retainOwnership(current: ReadonlySet<string>): void {
        for (const uuidValue of new Set([
            ...this.nameOwnership.keys(),
            ...this.headerOwnership,
            ...this.orderOwnership,
        ])) {
            if (current.has(uuidValue)) continue;
            this.dropOwnership(uuidValue);
        }
    }

    private dropOwnership(uuidValue: string): void {
        this.nameOwnership.delete(uuidValue);
        this.headerOwnership.delete(uuidValue);
        this.orderOwnership.delete(uuidValue);
    }
}

/** Returns whether a Java protocol version has the list-order field. */
export function supportsNativeOrder(version: string | undefined): boolean {
    if (version === undefined || version === 'unknown') return false;
    const match = /^v-(\d+)-(\d+)(?:-(\d+))?$/.exec(version);
    if (match === null) return false;
    const major = Number(match[1]);
    const minor = Number(match[2]);
    const patch = Number(match[3] ?? 0);
    return major > 1 || (major === 1 && (minor > 21 || (minor === 21 && patch >= 2)));
}

function readPlayer(player: Player): PlayerSnapshot {
    const id = uuid.toString(player.getId());
    const name = player.getName();
    const ping = player.getPing();
    let java = undefined as ReturnType<Player['asJava']>;
    let bedrock = undefined as ReturnType<Player['asBedrock']>;
    try {
        java = player.asJava();
        if (java !== undefined) {
            const javaVersion = java.getVersion();
            return { uuid: id, name, edition: 'java', javaVersion, ping };
        }
        bedrock = player.asBedrock();
        return { uuid: id, name, edition: bedrock === undefined ? 'unknown' : 'bedrock', ping };
    } finally {
        disposeWasiResource(java);
        disposeWasiResource(bedrock);
    }
}

function javaDisplaySupport(snapshot: PlayerSnapshot): ApplyResult {
    if (snapshot.edition !== 'java') return bedrockUnsupported('Java tab display fields');
    if (snapshot.javaVersion !== JAVA_DISPLAY_VERSION) {
        return {
            kind: 'unsupported',
            reason: `Java tab display calls are gated to ${JAVA_DISPLAY_VERSION}; live client behavior is unverified`,
        };
    }
    return { kind: 'applied' };
}

function bedrockUnsupported(feature: string): ApplyResult {
    return {
        kind: 'unsupported',
        reason: `Native Bedrock ${feature} are not supported; Pumpkin's roster stays unchanged`,
    };
}

function readTabName(player: Player): string | undefined {
    const component = player.getTabListName();
    try {
        return component?.toJson();
    } finally {
        disposeWasiResource(component);
    }
}

function styledLines(lines: readonly RenderedLine[]): TextComponent {
    const root = TextComponent.text('');
    try {
        for (const [index, line] of lines.entries()) {
            if (index > 0) {
                const separator = TextComponent.text('\n');
                try {
                    root.addChild(separator);
                } finally {
                    disposeWasiResource(separator);
                }
            }
            const child = styledText(line);
            try {
                root.addChild(child);
            } finally {
                disposeWasiResource(child);
            }
        }
        return root;
    } catch (error) {
        disposeWasiResource(root);
        throw error;
    }
}

function styledText(line: RenderedLine): TextComponent {
    const component = TextComponent.text(line.text);
    try {
        if (line.color !== undefined) component.colorRgb(toRgb(line.color));
        if (line.bold !== undefined) component.bold(line.bold);
        if (line.italic !== undefined) component.italic(line.italic);
        if (line.underlined !== undefined) component.underlined(line.underlined);
        if (line.strikethrough !== undefined) component.strikethrough(line.strikethrough);
        return component;
    } catch (error) {
        disposeWasiResource(component);
        throw error;
    }
}

function toRgb(color: string): RgbColor {
    if (!/^#[\da-fA-F]{6}$/.test(color)) throw new TypeError('Color must be an RGB value in #RRGGBB form');
    return {
        r: Number.parseInt(color.slice(1, 3), 16),
        g: Number.parseInt(color.slice(3, 5), 16),
        b: Number.parseInt(color.slice(5, 7), 16),
    };
}
