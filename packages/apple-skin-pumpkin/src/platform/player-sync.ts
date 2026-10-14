import type { JavaPlayer, Player } from 'pumpkin:plugin/player@0.1.0';
import type { Server } from 'pumpkin:plugin/server@0.1.0';
import { ansi } from '@pumpkin-plugins/minecraft-colors';
import type { Logger } from '@pumpkin-plugins/plugin-kit/logger';
import { bool, float32be } from '@pumpkin-plugins/plugin-kit/payload';
import { disposeWasiResource } from '@pumpkin-plugins/plugin-kit/wasi-resource';
import { PLUGIN_NAME } from '../name.ts';
import { EXHAUSTION_CHANNEL, NATURAL_REGENERATION_CHANNEL, SATURATION_CHANNEL } from '../payload.ts';
import { SyncTracker } from '../sync.ts';

// Pumpkin leaves the logging target out of its default output, so every line names the plugin.
const tag = ansi.named.name(PLUGIN_NAME);

/**
 * Keeps AppleSkin clients in step with the server's hunger values. Vanilla tells a client about
 * saturation only when it reaches zero and never sends exhaustion at all, which leaves the food
 * tooltips AppleSkin draws with both values behind. So the plugin reads every online player once
 * per tick and sends only what moved since the last packet. Every send is logged at debug level,
 * which Pumpkin hides until its `log.level` is set to `debug`.
 */
export class PlayerSync {
    private readonly sent = new SyncTracker();
    private readonly lastRegeneration = new Map<string, boolean>();
    private readonly failed = new Set<string>();

    constructor(private readonly log: Logger) {}

    /** Sends a joining player's values, and whether their world heals them by food. */
    joined(player: Player): void {
        this.syncPlayer(player, true);
    }

    /** Forgets a player who left, so that their next join starts from scratch. */
    left(player: Player): void {
        this.sent.forget(playerKey(player));
        this.lastRegeneration.delete(playerKey(player));
        this.failed.delete(playerKey(player));
        this.log.debug(`${tag} ${ansi.named.name(player.getName())} left, forgetting their hunger.`);
    }

    /**
     * Reads every online player's hunger and sends whatever moved since the last tick.
     * @param server - The server to read the players from.
     */
    tick(server: Server): void {
        const online = new Set<string>();
        for (const player of server.getAllPlayers()) this.syncPlayer(player, false, online);
        this.sent.retain(online);
        for (const id of this.lastRegeneration.keys()) if (!online.has(id)) this.lastRegeneration.delete(id);
        for (const id of this.failed) if (id !== 'unknown' && !online.has(id)) this.failed.delete(id);
    }

    private syncPlayer(player: Player, joined: boolean, online?: Set<string>): void {
        let id: string | undefined;
        try {
            try {
                id = playerKey(player);
                online?.add(id);
                const key = id;
                if (joined) {
                    this.sent.forget(key);
                    this.lastRegeneration.delete(key);
                }
                const sent = this.withJavaClient(player, (java) => {
                    if (joined) {
                        this.log.debug(
                            `${tag} ${ansi.named.name(player.getName())} joined, sending their current hunger.`,
                        );
                        this.sendRegeneration(player, key, java);
                    }
                    this.send(player, key, java);
                    if (!joined) this.sendRegeneration(player, key, java);
                });
                if (joined && !sent) {
                    this.log.debug(
                        `${tag} ${ansi.named.name(player.getName())} is not on Java Edition, so there is nothing to sync.`,
                    );
                }
            } finally {
                // List results are owned here; joining event handles belong to the event dispatcher.
                if (online) disposeWasiResource(player);
            }
            this.failed.delete(id ?? 'unknown');
        } catch (error) {
            const key = id ?? 'unknown';
            if (this.failed.has(key)) return;
            this.failed.add(key);
            try {
                this.log.warn(`${tag} Could not sync player ${key}: ${String(error).slice(0, 500)}`);
            } catch {
                // Failure reporting must not prevent another player's sync or disposal.
            }
        }
    }

    private send(player: Player, id: string, java: JavaPlayer): void {
        try {
            const update = this.sent.update(id, player.getSaturation(), player.getExhaustion());
            if (update.saturation === undefined && update.exhaustion === undefined) return;
            const who = player.getName();
            if (update.saturation !== undefined) {
                java.sendCustomPayload(SATURATION_CHANNEL, float32be(update.saturation));
                this.log.debug(`${tag} ${ansi.named.name(who)}: saturation ${ansi.named.number(update.saturation)}.`);
            }
            if (update.exhaustion !== undefined) {
                java.sendCustomPayload(EXHAUSTION_CHANNEL, float32be(update.exhaustion));
                this.log.debug(`${tag} ${ansi.named.name(who)}: exhaustion ${ansi.named.number(update.exhaustion)}.`);
            }
        } catch (error) {
            // A partial send cannot establish the baseline for either hunger field.
            this.sent.forget(id);
            throw error;
        }
    }

    private sendRegeneration(player: Player, id: string, java: JavaPlayer): void {
        const world = player.getWorld();
        try {
            const rule = world.getGameRule('natural-health-regeneration');
            if (rule.tag !== 'bool' || this.lastRegeneration.get(id) === rule.val) return;
            java.sendCustomPayload(NATURAL_REGENERATION_CHANNEL, bool(rule.val));
            this.lastRegeneration.set(id, rule.val);
            this.log.debug(
                `${tag} ${ansi.named.name(player.getName())}: natural regeneration is ${rule.val ? 'on' : 'off'} in ${ansi.named.name(world.getName())}.`,
            );
        } finally {
            disposeWasiResource(world);
        }
    }

    /** Runs `send` against a player's client, for the Java players AppleSkin runs on. */
    private withJavaClient(player: Player, send: (java: JavaPlayer) => void): boolean {
        const java = player.asJava();
        if (!java) return false;
        try {
            send(java);
        } finally {
            disposeWasiResource(java);
        }
        return true;
    }
}

/** A player's id, as the tracker keys them. A UUID is two bigint halves, so this costs no call. */
function playerKey(player: Player): string {
    const { high, low } = player.getId();
    return `${high}:${low}`;
}
