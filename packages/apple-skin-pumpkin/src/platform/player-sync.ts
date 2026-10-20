import type { GameRuleValue } from 'pumpkin:plugin/game-rules@0.1.0';
import type { JavaPlayer, Player } from 'pumpkin:plugin/player@0.1.0';
import type { Server } from 'pumpkin:plugin/server@0.1.0';
import type { World } from 'pumpkin:plugin/world@0.1.0';
import { ansi } from '@pumpkin-plugins/minecraft-colors';
import type { Logger } from '@pumpkin-plugins/plugin-kit/logger';
import { bool, float32be } from '@pumpkin-plugins/plugin-kit/payload';
import { disposeWasiResource } from '@pumpkin-plugins/plugin-kit/wasi-resource';
import { EXHAUSTION_CHANNEL, NATURAL_REGENERATION_CHANNEL, SATURATION_CHANNEL } from '../payload.ts';
import { SyncTracker } from '../sync.ts';

/**
 * Keeps AppleSkin clients in step with the server's hunger values. Vanilla tells a client about
 * saturation only when it reaches zero and never sends exhaustion at all, which leaves the food
 * tooltips AppleSkin draws with both values behind. So the plugin reads every online player once
 * per tick, walking the worlds so that each world's game rule is read once rather than per player,
 * and sends only what moved since the last packet. Every send is logged at debug level, which
 * Pumpkin hides until its `logging.level` is set to `debug`.
 */
export class PlayerSync {
    private readonly sent = new SyncTracker();
    private readonly lastRegeneration = new Map<string, boolean>();
    private readonly failed = new Set<string>();
    private ticked = false;

    constructor(private readonly log: Logger) {}

    /** Sends a joining player's values, and whether their world heals them by food. */
    joined(player: Player): void {
        this.syncPlayer(player);
    }

    /** Forgets a player who left, so that their next join starts from scratch. */
    left(player: Player): void {
        this.sent.forget(playerKey(player));
        this.lastRegeneration.delete(playerKey(player));
        this.failed.delete(playerKey(player));
        this.log.debug(`${ansi.named.name(player.getName())} left, forgetting their hunger.`);
    }

    /**
     * Reads every online player's hunger and sends whatever moved since the last tick.
     * @param server - The server to read the players from.
     */
    tick(server: Server): void {
        const online = new Set<string>();
        for (const world of server.getAllWorlds()) {
            try {
                const rule = new RegenerationRule(world);
                for (const player of server.getPlayersInWorld(world)) this.syncPlayer(player, { rule, online });
            } finally {
                disposeWasiResource(world);
            }
        }
        this.sent.retain(online);
        for (const id of this.lastRegeneration.keys()) if (!online.has(id)) this.lastRegeneration.delete(id);
        for (const id of this.failed) if (id !== 'unknown' && !online.has(id)) this.failed.delete(id);
        if (this.ticked) return;
        this.ticked = true;
        this.log.debug('Finished the first tick, syncing hunger on every tick from now on.');
    }

    /**
     * Syncs one player and reports a failure once per streak, so that one player cannot stop the rest.
     * @param player - The player to sync.
     * @param tick - The rule of the world the tick found the player in and the ids seen so far, or
     * `undefined` when the player just joined.
     */
    private syncPlayer(player: Player, tick?: { rule: RegenerationRule; online: Set<string> }): void {
        const joined = tick === undefined;
        let id: string | undefined;
        try {
            try {
                id = playerKey(player);
                tick?.online.add(id);
                const key = id;
                if (joined) {
                    this.sent.forget(key);
                    this.lastRegeneration.delete(key);
                }
                const sent = this.withJavaClient(player, (java) => {
                    if (joined) {
                        this.log.debug(`${ansi.named.name(player.getName())} joined, sending their current hunger.`);
                        this.sendJoinRegeneration(player, key, java);
                    }
                    this.send(player, key, java);
                    if (tick) this.sendRegeneration(player, key, java, tick.rule);
                });
                if (joined && !sent) {
                    this.log.debug(
                        `${ansi.named.name(player.getName())} is not on Java Edition, so there is nothing to sync.`,
                    );
                }
            } finally {
                // List results are owned here; joining event handles belong to the event dispatcher.
                if (tick) disposeWasiResource(player);
            }
            this.failed.delete(id ?? 'unknown');
        } catch (error) {
            const key = id ?? 'unknown';
            if (this.failed.has(key)) return;
            this.failed.add(key);
            try {
                this.log.warn(`Could not sync player ${key}: ${String(error).slice(0, 500)}`);
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
                this.log.debug(`${ansi.named.name(who)}: saturation ${ansi.named.number(update.saturation)}.`);
            }
            if (update.exhaustion !== undefined) {
                java.sendCustomPayload(EXHAUSTION_CHANNEL, float32be(update.exhaustion));
                this.log.debug(`${ansi.named.name(who)}: exhaustion ${ansi.named.number(update.exhaustion)}.`);
            }
        } catch (error) {
            // A partial send cannot establish the baseline for either hunger field.
            this.sent.forget(id);
            throw error;
        }
    }

    private sendJoinRegeneration(player: Player, id: string, java: JavaPlayer): void {
        const world = player.getWorld();
        try {
            this.sendRegeneration(player, id, java, new RegenerationRule(world));
        } finally {
            disposeWasiResource(world);
        }
    }

    private sendRegeneration(player: Player, id: string, java: JavaPlayer, rule: RegenerationRule): void {
        const value = rule.read();
        if (value.tag !== 'bool' || this.lastRegeneration.get(id) === value.val) return;
        java.sendCustomPayload(NATURAL_REGENERATION_CHANNEL, bool(value.val));
        this.lastRegeneration.set(id, value.val);
        this.log.debug(
            `${ansi.named.name(player.getName())}: natural regeneration is ${value.val ? 'on' : 'off'} in ${ansi.named.name(rule.world.getName())}.`,
        );
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

/**
 * A world's `natural-health-regeneration` rule, read from the host on first use and then kept, so
 * the players of one world share a single read. A failed read is kept too and thrown to each of them.
 */
class RegenerationRule {
    private result?: { value: GameRuleValue } | { error: unknown };

    constructor(readonly world: World) {}

    read(): GameRuleValue {
        if (!this.result) {
            try {
                this.result = { value: this.world.getGameRule('natural-health-regeneration') };
            } catch (error) {
                this.result = { error };
            }
        }
        if ('error' in this.result) throw this.result.error;
        return this.result.value;
    }
}

/** A player's id, as the tracker keys them. */
function playerKey(player: Player): string {
    const { high, low } = player.getId();
    return `${high}:${low}`;
}
