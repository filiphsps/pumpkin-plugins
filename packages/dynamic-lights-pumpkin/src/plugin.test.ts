import type { Context } from 'pumpkin:plugin/context@0.1.0';
import type { Player } from 'pumpkin:plugin/player@0.1.0';
import type { Server } from 'pumpkin:plugin/server@0.1.0';
import { MemoryFiles } from '@pumpkin-plugins/plugin-kit/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface LoadedPlugin {
    onPluginLoad(context: Context): void;
    onPluginUnload(context: Context): void;
    togglePlayerLights(player: Player): boolean;
}

const state = vi.hoisted(() => ({
    plugin: undefined as LoadedPlugin | undefined,
    files: undefined as (MemoryFiles & { [Symbol.dispose](): void }) | undefined,
    registerCommands: vi.fn(),
    events: new Map<string, (server: Server, event: unknown) => void>(),
    tasks: new Map<number, { repeating: boolean; run: (server: Server) => void }>(),
    nextTask: 0,
}));

vi.mock('pumpkin:plugin/uuid@0.1.0', () => ({ toString: (id: string) => id }));
vi.mock('@pumpkin-plugins/pumpkin-api', () => ({ handleCommand: vi.fn() }));
vi.mock('@pumpkin-plugins/plugin-kit/plugin', () => ({
    PluginBase: class {
        registerEvent(_ctx: Context, name: string, run: (server: Server, event: unknown) => void): void {
            state.events.set(name, run);
        }
    },
    registerPlugin: (plugin: LoadedPlugin) => {
        state.plugin = plugin;
    },
    handleCommand: vi.fn(),
    handleTask: vi.fn(),
}));
vi.mock('@pumpkin-plugins/plugin-kit/data-dir', () => ({ WasiDataDir: { open: () => state.files } }));
vi.mock('@pumpkin-plugins/plugin-kit/host', () => ({
    scheduleDelayed: (_delay: number, run: (server: Server) => void) => schedule(run, false),
    scheduleRepeating: (_delay: number, run: (server: Server) => void) => schedule(run, true),
    cancelTask: (id: number) => state.tasks.delete(id),
    hostLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    runCommand: vi.fn(),
}));
vi.mock('./commands/register.ts', () => ({ registerCommands: state.registerCommands }));
vi.mock('./platform/client-light-states.ts', () => ({ resolveClientLightStates: () => (level: number) => level }));

function schedule(run: (server: Server) => void, repeating: boolean): number {
    const id = ++state.nextTask;
    state.tasks.set(id, { run, repeating });
    return id;
}

describe('DynamicLightsPumpkin host lifecycle', () => {
    beforeEach(async () => {
        vi.resetModules();
        state.events.clear();
        state.tasks.clear();
        state.registerCommands.mockReset();
        state.files = Object.assign(new MemoryFiles(), { [Symbol.dispose]: vi.fn() });
        await import('./plugin.ts');
    }, 20_000);

    it('reads the selected item after the held-slot event has finished', () => {
        const env = setup();
        env.event('player-item-held-event');
        expect(env.player.sent).toEqual([]);
        env.player.item = 'minecraft:torch';

        env.delayed();

        expect(env.player.sent).toEqual([{ x: 0, y: 64, z: 0, level: 14 }]);
    });

    it.each(['block-place-event', 'player-bucket-empty-event', 'inventory-click-event'])(
        'refreshes the held light after %s changes the inventory',
        (eventName) => {
            const env = setup();
            env.player.item = 'minecraft:torch';
            env.event('player-join-event');
            env.delayed();
            env.event(eventName);
            env.player.item = undefined;
            env.delayed();
            expect(env.player.resets).toEqual([{ x: 0, y: 64, z: 0 }]);
        },
    );

    it('ignores a delayed lookup that returns null after the player disconnects', () => {
        const env = setup();
        env.event('player-item-held-event');
        env.player.online = false;
        expect(() => env.delayed()).not.toThrow();
    });

    it('reads the final position instead of a cancelled teleport destination', () => {
        const env = setup();
        env.player.item = 'minecraft:torch';
        env.event('player-join-event');
        env.delayed();
        env.player.sent.length = 0;

        env.event('player-teleport-event', { toPosition: [100, 64, 100], cancelled: true });
        env.delayed();

        expect(env.player.sent).toEqual([]);
        expect(env.player.resets).toEqual([]);
    });

    it('resends the same coordinates after changing world without resetting old-world cells', () => {
        const env = setup();
        env.player.item = 'minecraft:torch';
        env.event('player-join-event');
        env.delayed();
        env.player.sent.length = 0;
        env.player.worldId = 'nether';

        env.event('player-changed-world-event');
        env.delayed();

        expect(env.player.sent).toHaveLength(1);
        expect(env.player.resets).toEqual([]);
    });

    it('lights new player drops with no configured entity types, without lighting old unknown drops', () => {
        const files = state.files;
        if (files === undefined) throw new Error('Missing files');
        files.put('config.toml', '[entities]\nenabled = true\n[sources."minecraft:torch"]\nlight_level = 14\n');
        const env = setup();
        env.player.entities = [entity(7, 'item', 1)];

        env.event('player-drop-item-event', { itemName: 'minecraft:torch', cancelled: false });
        env.player.entities.push(entity(8, 'item', 2));
        env.delayed();
        env.repeating();

        expect(env.player.sent).toEqual([{ x: 2, y: 64, z: 0, level: 14 }]);
    });

    it('clears the last held light after dropping its item', () => {
        const env = setup();
        env.player.item = 'minecraft:torch';
        env.event('player-join-event');
        env.delayed();

        env.event('player-drop-item-event', { itemName: 'minecraft:torch', cancelled: false });
        env.player.item = undefined;
        env.delayed();

        expect(env.player.resets).toEqual([{ x: 0, y: 64, z: 0 }]);
    });

    it('restores client blocks and cancels pending work on unload', () => {
        const env = setup();
        const files = state.files;
        env.player.item = 'minecraft:torch';
        env.event('player-join-event');
        env.delayed();
        env.event('player-item-held-event');

        env.plugin.onPluginUnload(env.context);

        expect(env.player.resets).toEqual([{ x: 0, y: 64, z: 0 }]);
        expect(state.tasks.size).toBe(0);
        expect(files?.[Symbol.dispose]).toHaveBeenCalledOnce();
    });

    it('disposes the data directory when setup fails after opening it', () => {
        const plugin = state.plugin;
        const files = state.files;
        if (plugin === undefined || files === undefined) throw new Error('Missing plugin fixture');
        state.registerCommands.mockImplementationOnce(() => {
            throw new Error('registration failed');
        });

        expect(() => plugin.onPluginLoad({} as Context)).toThrow('registration failed');
        expect(files[Symbol.dispose]).toHaveBeenCalledOnce();
    });

    it("keeps a player's disabled choice after they change name", () => {
        const env = setup();
        env.player.item = 'minecraft:torch';
        env.plugin.togglePlayerLights(env.player as unknown as Player);
        env.player.name = 'Steve';

        env.event('player-join-event');
        env.delayed();

        expect(env.player.sent).toEqual([]);
    });

    it('lights players who are already online when loaded into a running server', () => {
        const env = setup({ item: 'minecraft:torch' });

        expect(env.player.sent).toEqual([{ x: 0, y: 64, z: 0, level: 14 }]);
    });

    it('cancels a pending refresh when the player leaves', () => {
        const env = setup();
        env.event('player-join-event');
        env.event('player-leave-event');
        env.delayed();
        expect(env.player.sent).toEqual([]);
        expect([...state.tasks.values()].every((task) => task.repeating)).toBe(true);
    });
});

function entity(id: number, type: string, x: number) {
    return { getId: () => id, getType: () => type, getPosition: () => [x, 64, 0] };
}

function setup(options: { item?: string } = {}) {
    const plugin = state.plugin;
    if (plugin === undefined) throw new Error('Plugin was not registered');
    // Test handles can omit Symbol.dispose even though generated declarations include it.
    const player = {
        online: true,
        item: options.item,
        worldId: 'overworld',
        entities: [] as ReturnType<typeof entity>[],
        sent: [] as { x: number; y: number; z: number; level: number }[],
        resets: [] as { x: number; y: number; z: number }[],
        name: 'Alex',
        getId: () => '853c80ef-3c37-49fd-aa49-938b674adae6',
        getName: () => player.name,
        getPosition: () => [0, 64, 0],
        getItemInHand: (hand: string) =>
            hand === 'right' && player.item !== undefined ? { getRegistryKey: () => player.item } : null,
        getWorld: () => ({ getId: () => player.worldId, getBlockState: () => ({ isAir: true }) }),
        asEntity: () => ({ getNearbyEntities: () => player.entities }),
        sendBlockChange: (position: { x: number; y: number; z: number }, level: number) =>
            player.sent.push({ ...position, level }),
        resetBlockChange: (position: { x: number; y: number; z: number }) => player.resets.push({ ...position }),
    };
    const server = {
        getAllPlayers: () => [player],
        getAllWorlds: () => [],
        getPlayerByName: () => (player.online ? player : null),
    } as unknown as Server;
    const context = { getServer: () => server } as Context;
    plugin.onPluginLoad(context);
    return {
        plugin,
        context,
        player,
        event(name: string, values: Record<string, unknown> = {}) {
            const callback = state.events.get(name);
            if (callback === undefined) throw new Error(`Missing event ${name}`);
            callback(server, { player, ...values });
        },
        delayed() {
            for (const [id, task] of [...state.tasks]) {
                if (task.repeating) continue;
                state.tasks.delete(id);
                task.run(server);
            }
        },
        repeating() {
            for (const task of state.tasks.values()) if (task.repeating) task.run(server);
        },
    };
}
