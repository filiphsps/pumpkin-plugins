import { ansi } from '@pumpkin-plugins/minecraft-colors';
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

    it.each([SATURATION, EXHAUSTION])('retries unchanged hunger after a tick send fails on %s', (channel) => {
        const { player, server, sync } = setup();
        player.beforeSend = (sent) => {
            if (sent === channel) throw new Error('fixture send failure');
        };
        expect(() => sync.tick(server.host)).not.toThrow();
        expect(player.disposals).toBe(2);
        player.beforeSend = undefined;
        player.sent.length = 0;

        sync.tick(server.host);

        expect(player.channels).toEqual([SATURATION, EXHAUSTION, REGENERATION]);
        expect(player.floats(SATURATION)).toEqual([5]);
        expect(player.floats(EXHAUSTION)).toEqual([Math.fround(0.4)]);
        expect(player.disposals).toBe(5);
    });

    it.each([SATURATION, EXHAUSTION])('retries unchanged hunger after a join send fails on %s', (channel) => {
        const { player, server, sync } = setup();
        player.beforeSend = (sent) => {
            if (sent === channel) throw new Error('fixture join failure');
        };
        expect(() => sync.joined(player.host)).not.toThrow();
        expect(player.disposals).toBe(2);
        player.beforeSend = undefined;
        player.sent.length = 0;

        sync.tick(server.host);

        expect(player.channels).toEqual([SATURATION, EXHAUSTION]);
        expect(player.disposals).toBe(5);
    });

    it.each([SATURATION, EXHAUSTION, REGENERATION])(
        'isolates a %s send failure and disposes every player',
        (channel) => {
            const { player, sync } = setup();
            const later = new FakePlayer('grace');
            const server = new FakeServer([player, later]);
            player.beforeSend = (sent) => {
                if (sent === channel) throw new Error('fixture failure');
            };

            expect(() => sync.tick(server.host)).not.toThrow();

            expect(later.channels).toEqual([SATURATION, EXHAUSTION, REGENERATION]);
            expect(later.disposals).toBe(3);
            expect(player.disposals).toBe(channel === REGENERATION ? 3 : 2);
            player.beforeSend = undefined;
            player.sent.length = 0;
            later.sent.length = 0;
            sync.tick(server.host);
            expect(player.channels).toEqual(
                channel === REGENERATION ? [REGENERATION] : [SATURATION, EXHAUSTION, REGENERATION]
            );
            expect(later.sent).toEqual([]);
        }
    );

    it('recovers a failed regeneration join send on the next tick', () => {
        const { player, server, sync } = setup();
        player.beforeSend = () => {
            throw new Error('join regeneration failure');
        };
        expect(() => sync.joined(player.host)).not.toThrow();
        expect(player.disposals).toBe(2);
        player.beforeSend = undefined;
        sync.tick(server.host);
        expect(player.channels).toEqual([SATURATION, EXHAUSTION, REGENERATION]);
        expect(player.disposals).toBe(5);
    });

    it.each([
        ['identity', 1],
        ['java', 1],
        ['saturation', 2],
        ['exhaustion', 2],
        ['world', 2],
        ['rule', 3],
        ['dispose', 3]
    ] as const)('continues after a player %s failure', (failure, disposals) => {
        const { player, sync } = setup();
        const later = new FakePlayer('grace');
        const fail = () => {
            throw new Error(`fixture ${failure} failure`);
        };
        if (failure === 'identity') player.getId = fail;
        else if (failure === 'java') player.asJava = fail;
        else if (failure === 'saturation') player.getSaturation = fail;
        else if (failure === 'exhaustion') player.getExhaustion = fail;
        else if (failure === 'world') player.getWorld = fail;
        else if (failure === 'rule') {
            const world = player.getWorld();
            world.getGameRule = fail;
            player.getWorld = () => world;
        } else
            Object.defineProperty(player, Symbol.dispose, {
                value: () => {
                    player.disposals++;
                    fail();
                }
            });
        expect(() => sync.tick(new FakeServer([player, later]).host)).not.toThrow();
        expect(later.channels).toEqual([SATURATION, EXHAUSTION, REGENERATION]);
        expect(later.disposals).toBe(3);
        expect(player.disposals).toBe(disposals);
    });

    it('continues serving later players even when failure reporting throws', () => {
        const { player, sync, log } = setup();
        const later = new FakePlayer('grace');
        player.beforeSend = () => {
            throw new Error('fixture send failure');
        };
        log.warn = () => {
            throw new Error('fixture logger failure');
        };
        expect(() => sync.tick(new FakeServer([player, later]).host)).not.toThrow();
        expect(later.channels).toEqual([SATURATION, EXHAUSTION, REGENERATION]);
        expect(player.disposals).toBe(2);
        expect(later.disposals).toBe(3);
    });

    it('reports one bounded warning per failure streak and resumes silent successful ticks', () => {
        const { player, server, sync, log } = setup();
        const fail = () => {
            throw new Error('x'.repeat(2000));
        };
        player.beforeSend = fail;
        for (let tick = 0; tick < 3; tick++) expect(() => sync.tick(server.host)).not.toThrow();
        expect(log.of('warn')).toHaveLength(1);
        expect(log.of('warn')[0]?.length).toBeLessThan(650);
        player.beforeSend = undefined;
        sync.tick(server.host);
        player.sent.length = 0;
        sync.tick(server.host);
        expect(player.sent).toEqual([]);
        player.saturation = 4;
        player.beforeSend = fail;
        sync.tick(server.host);
        expect(log.of('warn')).toHaveLength(2);
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

    it('syncs players when QuickJS handles have no explicit disposal method', () => {
        const { player, server, sync } = setup();
        Object.defineProperty(player, Symbol.dispose, { value: undefined });
        const world = player.getWorld();
        const java = player.asJava();
        if (java === undefined) throw new Error('Expected a Java client');
        Object.defineProperty(world, Symbol.dispose, { value: undefined });
        Object.defineProperty(java, Symbol.dispose, { value: undefined });
        player.getWorld = () => world;
        player.asJava = () => java;

        expect(() => sync.tick(server.host)).not.toThrow();
        expect(player.channels).toEqual([SATURATION, EXHAUSTION, REGENERATION]);
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
            `${ansi.named.name('AppleSkinPumpkin')} ${ansi.named.name('ada')} is not on Java Edition, so there is nothing to sync.`
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
            `${ansi.named.name('AppleSkinPumpkin')} ${ansi.named.name('ada')} joined, sending their current hunger.`,
            `${ansi.named.name('AppleSkinPumpkin')} ${ansi.named.name('ada')}: natural regeneration is on in ${ansi.named.name('world')}.`,
            `${ansi.named.name('AppleSkinPumpkin')} ${ansi.named.name('ada')}: saturation ${ansi.named.number('5')}.`,
            `${ansi.named.name('AppleSkinPumpkin')} ${ansi.named.name('ada')}: exhaustion ${ansi.named.number('0.4')}.`
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
