import type { GameRuleValue } from 'pumpkin:plugin/game-rules@0.1.0';
import type { JavaPlayer, Player } from 'pumpkin:plugin/player@0.1.0';
import type { Server } from 'pumpkin:plugin/server@0.1.0';
import type { Uuid } from 'pumpkin:plugin/uuid@0.1.0';
import type { World } from 'pumpkin:plugin/world@0.1.0';

/** One custom payload the plugin sent. */
export interface SentPayload {
    /** The channel it went out on, which is what tells the client what the bytes mean. */
    channel: string;
    data: Uint8Array;
}

/** A Java Edition client. The host hands these out per call, so each one is thrown away after use. */
class FakeJavaClient {
    constructor(private readonly player: FakePlayer) {}

    sendCustomPayload(channel: string, data: Uint8Array): void {
        this.player.sent.push({ channel, data });
    }

    [Symbol.dispose](): void {
        this.player.disposals++;
    }
}

/** The world a fake player is in, which only answers the game rule the plugin asks about. */
class FakeWorld {
    constructor(private readonly player: FakePlayer) {}

    getGameRule(): GameRuleValue {
        return { tag: 'bool', val: this.player.naturalRegeneration };
    }

    getName(): string {
        return this.player.worldName;
    }

    [Symbol.dispose](): void {
        this.player.disposals++;
    }
}

/**
 * A player the plugin can read and send to. Only the parts of the host's `Player` that the sync
 * touches are here, which is enough to stand in for one in a test.
 */
export class FakePlayer {
    /** The host's own handle for this player, which is what the plugin is written against. */
    readonly host = this as unknown as Player;

    /** Every payload the plugin has sent, in order. */
    readonly sent: SentPayload[] = [];

    /** How many of this player's handles the plugin has released. Anything it keeps is a leak. */
    disposals = 0;

    /** Their saturation level, which a test moves to fake eating. */
    saturation = 5;

    /** Their exhaustion level, which a test moves to fake sprinting. */
    exhaustion = 0.4;

    /** Whether the player's world heals them by food. */
    naturalRegeneration = true;

    /** The name of the world they are in, which shows up in the log when regeneration is off. */
    worldName = 'world';

    /** Set this to play a Bedrock Edition player, who has no Java client to sync. */
    bedrock = false;

    constructor(
        readonly name: string,
        readonly id: Uuid = { high: 1, low: name.length }
    ) {}

    /** The payloads sent on one channel, with their numbers read back. */
    floats(channel: string): number[] {
        return this.sent.filter((p) => p.channel === channel).map((p) => new DataView(p.data.buffer).getFloat32(0));
    }

    /** The payloads sent on one channel, with their flags read back. */
    flags(channel: string): boolean[] {
        return this.sent.filter((p) => p.channel === channel).map((p) => p.data[0] === 1);
    }

    /** The channels sent to, in order, which is easier to read than the payloads themselves. */
    get channels(): string[] {
        return this.sent.map((p) => p.channel);
    }

    getId(): Uuid {
        return this.id;
    }

    getName(): string {
        return this.name;
    }

    getSaturation(): number {
        return this.saturation;
    }

    getExhaustion(): number {
        return this.exhaustion;
    }

    getWorld(): World {
        return new FakeWorld(this) as unknown as World;
    }

    asJava(): JavaPlayer | undefined {
        return (this.bedrock ? undefined : new FakeJavaClient(this)) as unknown as JavaPlayer | undefined;
    }

    [Symbol.dispose](): void {
        this.disposals++;
    }
}

/** A server that hands out a fixed set of players. */
export class FakeServer {
    /** The host's own handle for this server, which is what the plugin is written against. */
    readonly host = this as unknown as Server;

    constructor(readonly players: FakePlayer[] = []) {}

    getAllPlayers(): Player[] {
        return this.players as unknown as Player[];
    }
}
