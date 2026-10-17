import type { Context } from 'pumpkin:plugin/context@0.1.0';
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface LoadedPlugin {
    handleIpcMessage(sender: string, message: Uint8Array): Uint8Array;
    onPluginLoad(context: Context): void;
    onPluginUnload(context: Context): void;
}

const state = vi.hoisted(() => ({
    files: undefined as unknown,
    plugin: undefined as LoadedPlugin | undefined,
    events: new Map<string, unknown>(),
    cleanupOrder: [] as string[],
    placeholderOptions: undefined as unknown,
    providerOptions: undefined as unknown,
    placeholderResponse: new Uint8Array([2]),
    baseResponse: new Uint8Array([1]),
    openDataDir: vi.fn(() => state.files),
    readSettings: vi.fn(),
    registerCommands: vi.fn(),
    serverPeers: vi.fn(() => ['live peer']),
    sessionsTick: vi.fn(),
    sessionsConstructor: vi.fn(),
    sessionsDispose: vi.fn(() => state.cleanupOrder.push('sessions-dispose')),
    placeholderConstructor: vi.fn(),
    providerConstructor: vi.fn(),
    warningScopeConstructor: vi.fn(),
    ipcSend: vi.fn(() => new Uint8Array()),
    placeholderTick: vi.fn(),
    placeholderIpc: vi.fn((_sender: string, _message: Uint8Array) => state.placeholderResponse),
    placeholderStop: vi.fn(() => state.cleanupOrder.push('stop')),
    baseIpc: vi.fn((_sender: string, _message: Uint8Array) => state.baseResponse),
    hostInfo: vi.fn(),
    hostWarn: vi.fn(),
}));

vi.mock('@pumpkin-plugins/plugin-kit/data-dir', () => ({ WasiDataDir: { open: state.openDataDir } }));
vi.mock('@pumpkin-plugins/plugin-kit/ipc', () => ({ ipcSend: state.ipcSend }));
vi.mock('@pumpkin-plugins/plugin-kit/host', () => ({ hostLogger: { info: state.hostInfo, warn: state.hostWarn } }));
vi.mock('@pumpkin-plugins/pumpkin-plus-plus-api', () => ({
    PumpkinPlusPlusSession: class {
        constructor(options: unknown) {
            state.providerOptions = options;
            state.providerConstructor();
        }
    },
    WarningScope: class {
        constructor() {
            state.warningScopeConstructor();
        }
    },
}));
vi.mock('@pumpkin-plugins/pumpkin-api', () => ({ handleCommand: vi.fn(), handleTask: vi.fn() }));
vi.mock('wasi:clocks/monotonic-clock@0.2.3', () => ({ now: () => 0n }));
vi.mock('@pumpkin-plugins/plugin-kit/plugin', () => ({
    PluginBase: class {
        registerEvent(_context: unknown, name: string, handler: unknown): void {
            state.events.set(name, handler);
        }

        handleIpcMessage(sender: string, message: Uint8Array): Uint8Array {
            return state.baseIpc(sender, message);
        }

        onPluginUnload(): void {}
    },
    registerPlugin: (plugin: LoadedPlugin) => {
        state.plugin = plugin;
    },
}));
vi.mock('@pumpkin-plugins/plugin-kit/register-commands', () => ({ registerCommands: state.registerCommands }));
vi.mock('./commands/handlers.ts', () => ({ commandHandlers: vi.fn(() => ({})) }));
vi.mock('./commands/spec.ts', () => ({ commands: [] }));
vi.mock('./config/load.ts', () => ({ readSettings: state.readSettings }));
vi.mock('./info.ts', () => ({ info: { name: 'DistantHorizonsSupportPumpkin' } }));
vi.mock('./lod/cache.ts', () => ({ LodCache: class {} }));
vi.mock('./name.ts', () => ({ PLUGIN_NAME: 'DistantHorizonsSupportPumpkin' }));
vi.mock('./platform/peers.ts', () => ({ serverPeers: state.serverPeers, withPlayer: vi.fn() }));
vi.mock('./platform/world-mutations.ts', () => ({ invalidateBlockGrow: vi.fn(), invalidateBlockSpread: vi.fn() }));
vi.mock('./protocol/messages.ts', () => ({ CHANNEL: 'dh', PROTOCOL: 16 }));
vi.mock('./session.ts', () => ({
    Sessions: class {
        constructor(...args: unknown[]) {
            state.sessionsConstructor(...args);
        }

        tick(peers: unknown, serverMspt: number): void {
            state.sessionsTick(peers, serverMspt);
        }

        dispose(): void {
            state.sessionsDispose();
        }
    },
}));
vi.mock('./placeholders/service.ts', () => ({
    DistantHorizonsPlaceholderService: class {
        constructor(options: unknown) {
            state.placeholderOptions = options;
            state.placeholderConstructor();
        }

        tick(): void {
            state.placeholderTick();
        }

        handleIpcMessage(sender: string, message: Uint8Array): Uint8Array {
            return state.placeholderIpc(sender, message);
        }

        stop(): void {
            state.placeholderStop();
        }
    },
}));

describe('DistantHorizonsSupportPumpkin lifecycle', () => {
    beforeEach(async () => {
        vi.resetModules();
        vi.clearAllMocks();
        state.plugin = undefined;
        state.events.clear();
        state.cleanupOrder.length = 0;
        state.placeholderOptions = undefined;
        state.providerOptions = undefined;
        state.placeholderResponse = new Uint8Array([2]);
        state.baseResponse = new Uint8Array([1]);
        state.placeholderIpc.mockImplementation(() => state.placeholderResponse);
        state.baseIpc.mockImplementation(() => state.baseResponse);
        state.placeholderStop.mockImplementation(() => state.cleanupOrder.push('stop'));
        state.sessionsDispose.mockImplementation(() => state.cleanupOrder.push('sessions-dispose'));
        state.serverPeers.mockReturnValue(['live peer']);
        state.files = {
            [Symbol.dispose]: vi.fn(() => state.cleanupOrder.push('dispose')),
        };
        state.readSettings.mockReturnValue({});
        await import('./plugin.ts');
    });

    it('creates the optional service and ticks it without skipping DH processing on PIE failure', () => {
        const plugin = state.plugin;
        if (!plugin) throw new Error('Plugin was not registered');
        const context = {} as Context;

        plugin.onPluginLoad(context);
        expect(state.providerConstructor).toHaveBeenCalledOnce();
        expect(state.warningScopeConstructor).toHaveBeenCalledOnce();
        expect(state.providerOptions).toMatchObject({
            send: state.ipcSend,
            now: expect.any(Function),
            warn: state.hostWarn,
            warnings: expect.any(Object),
        });
        expect(state.sessionsConstructor).toHaveBeenCalledWith(
            expect.any(Object),
            expect.any(Object),
            expect.any(Object),
            expect.any(Function),
            expect.any(Function),
            expect.any(Object),
            expect.any(Function),
        );
        expect(state.placeholderConstructor).toHaveBeenCalledOnce();
        expect(state.placeholderOptions).toMatchObject({
            sessions: expect.any(Object),
            cache: expect.any(Object),
            now: expect.any(Function),
            onTransition: expect.any(Function),
        });

        state.placeholderTick.mockImplementationOnce(() => {
            throw new Error('PIE tick failed');
        });
        const tickEnd = state.events.get('server-tick-end-event');
        if (typeof tickEnd !== 'function') throw new Error('Tick-end handler was not registered');
        tickEnd({ getMspt: () => 42 });

        expect(state.sessionsTick).toHaveBeenCalledOnce();
        expect(state.sessionsTick).toHaveBeenCalledWith(['live peer'], 42);
        expect(state.hostWarn).toHaveBeenCalledWith(expect.stringContaining('PumpkinPIE session tick failed'));
        plugin.onPluginUnload(context);
        expect(state.placeholderStop).toHaveBeenCalledOnce();
        expect(state.sessionsDispose).toHaveBeenCalledOnce();
        expect(state.cleanupOrder).toEqual(['stop', 'sessions-dispose', 'dispose']);
    });

    it('routes authenticated IPC and preserves the base handler when the service is absent', () => {
        const plugin = state.plugin;
        if (!plugin) throw new Error('Plugin was not registered');
        const context = {} as Context;
        const message = new Uint8Array([9, 8, 7]);

        plugin.onPluginLoad(context);
        expect(plugin.handleIpcMessage('PumpkinPIE', message)).toBe(state.placeholderResponse);
        expect(state.placeholderIpc).toHaveBeenCalledWith('PumpkinPIE', message);

        plugin.onPluginUnload(context);
        expect(plugin.handleIpcMessage('OtherPlugin', message)).toBe(state.baseResponse);
        expect(state.baseIpc).toHaveBeenCalledWith('OtherPlugin', message);
    });

    it('stops a partially initialized service before disposing its data directory', () => {
        const plugin = state.plugin;
        if (!plugin) throw new Error('Plugin was not registered');
        const files = state.files as { [Symbol.dispose](): void };
        const context = {} as Context;
        const failure = new Error('command registration failed');
        state.registerCommands.mockImplementationOnce(() => {
            throw failure;
        });

        expect(() => plugin.onPluginLoad(context)).toThrow(failure);
        expect(files[Symbol.dispose]).toHaveBeenCalledOnce();
        expect(state.placeholderStop).toHaveBeenCalledOnce();
        expect(state.sessionsDispose).toHaveBeenCalledOnce();
        expect(state.cleanupOrder).toEqual(['stop', 'sessions-dispose', 'dispose']);
    });
});
