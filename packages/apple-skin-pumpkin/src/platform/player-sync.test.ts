import { colorLogValue } from '@pumpkin-plugins/plugin-kit/logger';
import { MemoryLogger } from '@pumpkin-plugins/plugin-kit/testing';
import { describe, expect, it } from 'vitest';
import { FakePlayer, FakeServer } from '../../test/fake-player.ts';
import { PlayerSync } from './player-sync.ts';

const SATURATION = 'appleskin:saturation';
const EXHAUSTION = 'appleskin:exhaustion';
const REGENERATION = 'appleskin:natural_regeneration';

describe('PlayerSync', () => {
    it('sends both hunger values to a joining player, because the client starts on its own defaults', () => {
        const { player, sync } = setup();

        sync.joined(player.host);

        expect(player.channels).toEqual([REGENERATION, SATURATION, EXHAUSTION]);
        expect(player.flags(REGENERATION)).toEqual([true]);
        expect(player.floats(SATURATION)).toEqual([5]);
        // The values travel as 32-bit floats, so what arrives is the nearest one the format holds.
        expect(player.floats(EXHAUSTION)).toEqual([Math.fround(0.4)]);
    });

    it('tells the client whether natural regeneration is on in the world it joined', () => {
        const { player, sync } = setup();
        player.worldName = 'arena';

        sync.joined(player.host);

        expect(player.flags(REGENERATION)).toEqual([true]);
    });

    it('updates natural regeneration after a gamerule change or world transition', () => {
        const { player, server, sync } = setup();
        sync.joined(player.host);
        player.sent.length = 0;

        player.naturalRegeneration = false;
        sync.tick(server.host);

        player.naturalRegeneration = true;
        player.worldName = 'world_nether';
        sync.tick(server.host);
        sync.tick(server.host);

        expect(player.flags(REGENERATION)).toEqual([false, true]);
    });

    it('sends a value on the tick it changes, and only then', () => {
        const { player, server, sync } = setup();
        sync.tick(server.host);
        player.sent.length = 0;

        // Eating moves saturation. Walking does not move exhaustion far enough to be worth a packet.
        player.saturation = 4.5;
        player.exhaustion = 0.405;
        sync.tick(server.host);

        expect(player.floats(SATURATION)).toEqual([4.5]);
        expect(player.floats(EXHAUSTION)).toEqual([]);

        player.exhaustion = 0.42;
        sync.tick(server.host);

        expect(player.floats(EXHAUSTION)).toEqual([Math.fround(0.42)]);
        expect(player.floats(SATURATION)).toEqual([4.5]);
    });

    it('releases every handle the host handed out, so the resource table does not grow', () => {
        const { player, server, sync } = setup();

        sync.tick(server.host);

        // One for the player out of the server's list, one Java client and one world handle.
        expect(player.disposals).toBe(3);

        player.saturation = 4.5;
        sync.tick(server.host);

        expect(player.disposals).toBe(6);
    });

    it('releases the world handle too, when it reads the game rule', () => {
        const { player, sync } = setup();

        sync.joined(player.host);

        // One Java client and one world handle.
        expect(player.disposals).toBe(2);
    });

    it('leaves Bedrock players alone, and says why once instead of every tick', () => {
        const { player, server, sync, log } = setup();
        player.bedrock = true;

        sync.joined(player.host);
        sync.tick(server.host);

        expect(player.sent).toEqual([]);
        expect(log.of('debug')).toEqual([
            `${colorLogValue('AppleSkinPumpkin', 'cyan')} ${colorLogValue('ada', 'cyan')} is not on Java Edition, so there is nothing to sync.`
        ]);
    });

    it('sends everything again after a player leaves and comes back', () => {
        const { player, sync } = setup();
        sync.joined(player.host);
        sync.left(player.host);
        player.sent.length = 0;

        sync.joined(player.host);

        expect(player.floats(SATURATION)).toEqual([5]);
        expect(player.floats(EXHAUSTION)).toEqual([Math.fround(0.4)]);
    });

    it('logs what it sent, with the player and the value', () => {
        const { player, sync, log } = setup();

        sync.joined(player.host);

        expect(log.of('debug')).toEqual([
            `${colorLogValue('AppleSkinPumpkin', 'cyan')} ${colorLogValue('ada', 'cyan')} joined, sending their current hunger.`,
            `${colorLogValue('AppleSkinPumpkin', 'cyan')} ${colorLogValue('ada', 'cyan')}: natural regeneration is on in ${colorLogValue('world', 'cyan')}.`,
            `${colorLogValue('AppleSkinPumpkin', 'cyan')} ${colorLogValue('ada', 'cyan')}: saturation ${colorLogValue('5', 'yellow')}.`,
            `${colorLogValue('AppleSkinPumpkin', 'cyan')} ${colorLogValue('ada', 'cyan')}: exhaustion ${colorLogValue('0.4', 'yellow')}.`
        ]);
    });

    it('says nothing on a tick where nothing moved, which is most of them', () => {
        const { player, server, sync, log } = setup();
        sync.joined(player.host);
        log.lines.length = 0;
        player.sent.length = 0;

        sync.tick(server.host);

        expect(player.sent).toEqual([]);
        expect(log.lines).toEqual([]);
    });
});

/** A sync with one Java player on the server, and the log the tests read back. */
function setup() {
    const player = new FakePlayer('ada');
    const server = new FakeServer([player]);
    const log = new MemoryLogger();
    return { player, server, sync: new PlayerSync(log), log };
}
