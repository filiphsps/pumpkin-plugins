import type { JavaPlayer, Player } from 'pumpkin:plugin/player@0.1.0';
import type { Server } from 'pumpkin:plugin/server@0.1.0';
import { colorLogValue, type Logger } from '@pumpkin-plugins/plugin-kit/logger';
import { bool, float32be } from '@pumpkin-plugins/plugin-kit/payload';
import { disposeWasiResource } from '@pumpkin-plugins/plugin-kit/wasi-resource';
import { EXHAUSTION_CHANNEL, NATURAL_REGENERATION_CHANNEL, SATURATION_CHANNEL } from '../payload.ts';
import { SyncTracker } from '../sync.ts';

// Pumpkin leaves the logging target out of its default output, so every line names the plugin.
const tag = colorLogValue('AppleSkinPumpkin', 'cyan');

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

    constructor(private readonly log: Logger) {}

    /** Sends a joining player's values, and whether their world heals them by food. */
    joined(player: Player): void {
        const id = playerKey(player);
        this.sent.forget(id);
        this.lastRegeneration.delete(id);
        const sent = this.withJavaClient(player, (java) => {
            this.log.debug(`${tag} ${colorLogValue(player.getName(), 'cyan')} joined, sending their current hunger.`);
            this.sendRegeneration(player, id, java);
            this.send(player, id, java);
        });
        if (!sent) {
            this.log.debug(
                `${tag} ${colorLogValue(player.getName(), 'cyan')} is not on Java Edition, so there is nothing to sync.`
            );
        }
    }

    /** Forgets a player who left, so that their next join starts from scratch. */
    left(player: Player): void {
        this.sent.forget(playerKey(player));
        this.lastRegeneration.delete(playerKey(player));
        this.log.debug(`${tag} ${colorLogValue(player.getName(), 'cyan')} left, forgetting their hunger.`);
    }

    /**
     * Reads every online player's hunger and sends whatever moved since the last tick.
     * @param server - The server to read the players from.
     */
    tick(server: Server): void {
        const online = new Set<string>();
        for (const player of server.getAllPlayers()) {
            try {
                const id = playerKey(player);
                online.add(id);
                this.withJavaClient(player, (java) => {
                    this.send(player, id, java);
                    this.sendRegeneration(player, id, java);
                });
            } finally {
                // Release handles when the runtime exposes explicit disposal.
                disposeWasiResource(player);
            }
        }
        this.sent.retain(online);
        for (const id of this.lastRegeneration.keys()) if (!online.has(id)) this.lastRegeneration.delete(id);
    }

    private send(player: Player, id: string, java: JavaPlayer): void {
        const update = this.sent.update(id, player.getSaturation(), player.getExhaustion());
        if (update.saturation === undefined && update.exhaustion === undefined) return;
        const who = player.getName();
        if (update.saturation !== undefined) {
            java.sendCustomPayload(SATURATION_CHANNEL, float32be(update.saturation));
            this.log.debug(
                `${tag} ${colorLogValue(who, 'cyan')}: saturation ${colorLogValue(String(update.saturation), 'yellow')}.`
            );
        }
        if (update.exhaustion !== undefined) {
            java.sendCustomPayload(EXHAUSTION_CHANNEL, float32be(update.exhaustion));
            this.log.debug(
                `${tag} ${colorLogValue(who, 'cyan')}: exhaustion ${colorLogValue(String(update.exhaustion), 'yellow')}.`
            );
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
                `${tag} ${colorLogValue(player.getName(), 'cyan')}: natural regeneration is ${rule.val ? 'on' : 'off'} in ${colorLogValue(world.getName(), 'cyan')}.`
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

/** A player's id, as the tracker keys them. A UUID is two numbers here, so this costs no call. */
function playerKey(player: Player): string {
    const { high, low } = player.getId();
    return `${high}:${low}`;
}
