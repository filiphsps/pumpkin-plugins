import type { JavaPlayer, Player } from 'pumpkin:plugin/player@0.1.0';
import type { Server } from 'pumpkin:plugin/server@0.1.0';
import type { Logger } from '@pumpkin-plugins/plugin-kit/logger';
import {
    boolPayload,
    EXHAUSTION_CHANNEL,
    floatPayload,
    NATURAL_REGENERATION_CHANNEL,
    SATURATION_CHANNEL
} from '../payload.ts';
import { SyncTracker } from '../sync.ts';

// Pumpkin leaves the logging target out of its default output, so every line names the plugin.
const tag = 'AppleSkinPumpkin';

/**
 * Keeps AppleSkin clients in step with the server's hunger values. Vanilla tells a client about
 * saturation only when it reaches zero and never sends exhaustion at all, which leaves the food
 * tooltips AppleSkin draws with both values behind. So the plugin reads every online player once
 * per tick and sends only what moved since the last packet. Every send is logged at debug level,
 * which Pumpkin hides until its `log.level` is set to `debug`.
 */
export class PlayerSync {
    private readonly sent = new SyncTracker();

    constructor(private readonly log: Logger) {}

    /** Sends a joining player's values, and whether their world heals them by food. */
    joined(player: Player): void {
        const id = playerKey(player);
        this.sent.forget(id);
        if (!isJavaPlayer(player)) {
            this.log.debug(`${tag} ${player.getName()} is not on Java Edition, so there is nothing to sync.`);
            return;
        }
        this.log.debug(`${tag} ${player.getName()} joined, sending their current hunger.`);
        this.sendRegeneration(player);
        this.send(player, id);
    }

    /** Forgets a player who left, so that their next join starts from scratch. */
    left(player: Player): void {
        this.sent.forget(playerKey(player));
        this.log.debug(`${tag} ${player.getName()} left, forgetting their hunger.`);
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
                this.send(player, id);
            } finally {
                // Every handle the host hands out is ours to release. Keeping them would grow the
                // server's resource table by one entry per player per tick.
                player[Symbol.dispose]();
            }
        }
        this.sent.retain(online);
    }

    private send(player: Player, id: string): void {
        this.withJavaClient(player, (java) => {
            const update = this.sent.update(id, player.getSaturation(), player.getExhaustion());
            if (update.saturation === undefined && update.exhaustion === undefined) return;
            const who = player.getName();
            if (update.saturation !== undefined) {
                java.sendCustomPayload(SATURATION_CHANNEL, floatPayload(update.saturation));
                this.log.debug(`${tag} ${who}: saturation ${update.saturation}.`);
            }
            if (update.exhaustion !== undefined) {
                java.sendCustomPayload(EXHAUSTION_CHANNEL, floatPayload(update.exhaustion));
                this.log.debug(`${tag} ${who}: exhaustion ${update.exhaustion}.`);
            }
        });
    }

    private sendRegeneration(player: Player): void {
        const world = player.getWorld();
        try {
            const rule = world.getGameRule('natural-health-regeneration');
            // The client assumes regeneration is on, so only an off switch is worth a packet.
            if (rule.tag !== 'bool' || rule.val) return;
            this.withJavaClient(player, (java) => {
                java.sendCustomPayload(NATURAL_REGENERATION_CHANNEL, boolPayload(false));
                this.log.debug(`${tag} ${player.getName()}: natural regeneration is off in ${world.getName()}.`);
            });
        } finally {
            world[Symbol.dispose]();
        }
    }

    /** Runs `send` against a player's client, for the Java players AppleSkin runs on. */
    private withJavaClient(player: Player, send: (java: JavaPlayer) => void): void {
        const java = player.asJava();
        if (!java) return;
        try {
            send(java);
        } finally {
            java[Symbol.dispose]();
        }
    }
}

/** A player's id, as the tracker keys them. A UUID is two numbers here, so this costs no call. */
function playerKey(player: Player): string {
    const { high, low } = player.getId();
    return `${high}:${low}`;
}

/** Whether a player has a Java client. AppleSkin is a Java mod, so nobody else is worth syncing. */
function isJavaPlayer(player: Player): boolean {
    const java = player.asJava();
    if (!java) return false;
    java[Symbol.dispose]();
    return true;
}
