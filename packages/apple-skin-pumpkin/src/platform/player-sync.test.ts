import { ansi } from '@pumpkin-plugins/minecraft-colors';
import { MemoryLogger } from '@pumpkin-plugins/plugin-kit/testing';
import { describe, expect, it } from 'vitest';
import { FakePlayer, FakeServer, FakeWorld } from '../../test/fake-player.ts';
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
        expect(player.disposals).toBe(4);
    });

    it.each([SATURATION, EXHAUSTION])('retries unchanged hunger after a join send fails on %s', (channel) => {
        const { player, server, sync } = setup();
        player.beforeSend = (sent) => {
            if (sent === channel) throw new Error('fixture join failure');
        };
        expect(() => sync.joined(player.host)).not.toThrow();
        expect(player.disposals).toBe(1);
        player.beforeSend = undefined;
        player.sent.length = 0;

        sync.tick(server.host);

        expect(player.channels).toEqual([SATURATION, EXHAUSTION]);
        expect(player.disposals).toBe(3);
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
            expect(later.disposals).toBe(2);
            expect(player.disposals).toBe(2);
            player.beforeSend = undefined;
            player.sent.length = 0;
            later.sent.length = 0;
            sync.tick(server.host);
            expect(player.channels).toEqual(
                channel === REGENERATION ? [REGENERATION] : [SATURATION, EXHAUSTION, REGENERATION],
            );
            expect(later.sent).toEqual([]);
        },
    );

    it('recovers a failed regeneration join send on the next tick', () => {
        const { player, server, sync } = setup();
        player.beforeSend = () => {
            throw new Error('join regeneration failure');
        };
        expect(() => sync.joined(player.host)).not.toThrow();
        expect(player.disposals).toBe(1);
        expect(player.world.disposals).toBe(1);
        player.beforeSend = undefined;
        sync.tick(server.host);
        expect(player.channels).toEqual([SATURATION, EXHAUSTION, REGENERATION]);
        expect(player.disposals).toBe(3);
    });

    it.each([
        ['identity', 1],
        ['java', 1],
        ['saturation', 2],
        ['exhaustion', 2],
        ['rule', 2],
        ['dispose', 2],
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
        else if (failure === 'rule') player.world.getGameRule = fail;
        else
            Object.defineProperty(player, Symbol.dispose, {
                value: () => {
                    player.disposals++;
                    fail();
                },
            });
        expect(() => sync.tick(new FakeServer([player, later]).host)).not.toThrow();
        expect(later.channels).toEqual([SATURATION, EXHAUSTION, REGENERATION]);
        expect(later.disposals).toBe(2);
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
        expect(later.disposals).toBe(2);
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
        player.world = new FakeWorld('arena');

        sync.joined(player.host);

        expect(player.flags(REGENERATION)).toEqual([true]);
    });

    it('updates natural regeneration after a gamerule change or world transition', () => {
        const { player, server, sync } = setup();
        sync.joined(player.host);
        player.sent.length = 0;

        player.world.naturalRegeneration = false;
        sync.tick(server.host);

        player.world = new FakeWorld('world_nether');
        sync.tick(server.host);
        sync.tick(server.host);

        expect(player.flags(REGENERATION)).toEqual([false, true]);
    });

    it('reads the game rule once per world on a tick, however many players are in it', () => {
        const ada = new FakePlayer('ada');
        const grace = new FakePlayer('grace');
        const linus = new FakePlayer('linus');
        grace.world = ada.world;
        ada.world.naturalRegeneration = false;
        linus.world = new FakeWorld('world_nether');
        const sync = new PlayerSync(new MemoryLogger());

        sync.tick(new FakeServer([ada, grace, linus]).host);

        expect(ada.world.ruleReads).toBe(1);
        expect(linus.world.ruleReads).toBe(1);
        expect(ada.flags(REGENERATION)).toEqual([false]);
        expect(grace.flags(REGENERATION)).toEqual([false]);
        expect(linus.flags(REGENERATION)).toEqual([true]);
    });

    it('still sends hunger to everyone in a world whose game rule cannot be read', () => {
        const { player, log } = setup();
        const grace = new FakePlayer('grace');
        grace.world = player.world;
        player.world.getGameRule = () => {
            throw new Error('fixture rule failure');
        };
        const sync = new PlayerSync(log);

        sync.tick(new FakeServer([player, grace]).host);

        for (const each of [player, grace]) expect(each.channels).toEqual([SATURATION, EXHAUSTION]);
        expect(log.of('warn')).toHaveLength(2);
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

    it('syncs players when host handles have no explicit disposal method', () => {
        const { player, server, sync } = setup();
        Object.defineProperty(player, Symbol.dispose, { value: undefined });
        const java = player.asJava();
        if (java === undefined) throw new Error('Expected a Java client');
        Object.defineProperty(player.world, Symbol.dispose, { value: undefined });
        Object.defineProperty(java, Symbol.dispose, { value: undefined });
        player.asJava = () => java;

        expect(() => sync.tick(server.host)).not.toThrow();
        expect(player.channels).toEqual([SATURATION, EXHAUSTION, REGENERATION]);
    });

    it('releases every handle the host handed out, so the resource table does not grow', () => {
        const { player, server, sync } = setup();

        sync.tick(server.host);

        // One for the player out of the world's list and one Java client, plus the world handle.
        expect(player.disposals).toBe(2);
        expect(player.world.disposals).toBe(1);

        player.saturation = 4.5;
        sync.tick(server.host);

        expect(player.disposals).toBe(4);
        expect(player.world.disposals).toBe(2);
    });

    it('releases the world handle too, when it reads the game rule', () => {
        const { player, sync } = setup();

        sync.joined(player.host);

        expect(player.disposals).toBe(1);
        expect(player.world.disposals).toBe(1);
    });

    it('leaves Bedrock players alone, and says why once instead of every tick', () => {
        const { player, server, sync, log } = setup();
        player.bedrock = true;

        sync.joined(player.host);
        sync.tick(server.host);

        expect(player.sent).toEqual([]);
        sync.tick(server.host);

        expect(log.of('debug').filter((line) => line.includes('Java Edition'))).toEqual([
            `${ansi.named.name('ada')} is not on Java Edition, so there is nothing to sync.`,
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
            `${ansi.named.name('ada')} joined, sending their current hunger.`,
            `${ansi.named.name('ada')}: natural regeneration is on in ${ansi.named.name('world')}.`,
            `${ansi.named.name('ada')}: saturation ${ansi.named.number('5')}.`,
            `${ansi.named.name('ada')}: exhaustion ${ansi.named.number('0.4')}.`,
        ]);
    });

    it('says once, after its first tick, that it is syncing', () => {
        const { sync, log } = setup();
        const empty = new FakeServer().host;

        sync.tick(empty);
        sync.tick(empty);

        expect(log.of('debug')).toEqual(['Finished the first tick, syncing hunger on every tick from now on.']);
    });

    it('says nothing on a tick where nothing moved, which is most of them', () => {
        const { player, server, sync, log } = setup();
        sync.joined(player.host);
        sync.tick(server.host);
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
