import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { generateEsmFacade, generateWasiEsmFacade } from './facades.ts';
import { generateWitApiFunctionForResolvedOperation } from './native-adapters.ts';
import type { ResolvedWitType, WitApiInterface, WitApiPackage, WitFunction, WitWasiInterface } from './types.ts';

const directories: string[] = [];
const globalState = globalThis as typeof globalThis & Record<string, unknown>;
const previousPumpkinHost = globalState.__pumpkinHost;
const previousWasiHost = globalState.__pumpkinWasiFilesystemTypes;
const previousUnloading = globalState.__staticHermesPluginUnloading;

afterEach(() => {
    for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
    restoreGlobal('__pumpkinHost', previousPumpkinHost);
    restoreGlobal('__pumpkinWasiFilesystemTypes', previousWasiHost);
    restoreGlobal('__staticHermesPluginUnloading', previousUnloading);
});

it('allows scheduler task cancellation during unload and blocks other host calls', async () => {
    const scheduler = apiInterface('scheduler', 'pumpkin:plugin/scheduler@0.1.0', [
        operation('cancel-task'),
        operation('schedule-task'),
    ]);
    const module = (await importFacade(generateEsmFacade(scheduler))) as unknown as SchedulerFacade;
    globalState.__pumpkinHost = {
        scheduler: {
            cancelTask: (id: number) => `cancelled:${id}`,
            scheduleTask: () => 'scheduled',
        },
    };
    globalState.__staticHermesPluginUnloading = true;

    expect(module.cancelTask(7)).toBe('cancelled:7');
    expect(() => module.scheduleTask()).toThrow('Pumpkin host calls are unavailable during plugin unload');
});

it('turns Pumpkin WIT result errors into JavaScript errors', async () => {
    const saveAll = { ...operation('save-all'), result: 'result<_, string>' };
    const server = apiInterface('server', 'pumpkin:plugin/server@0.1.0', [saveAll]);
    const apiPackage: WitApiPackage = {
        packageName: 'pumpkin:plugin',
        version: '0.1.0',
        interfaces: [server],
    };
    const resultType: ResolvedWitType = {
        kind: 'result',
        ok: { kind: 'unit' },
        error: { kind: 'primitive', name: 'string' },
    };
    const adapter = generateWitApiFunctionForResolvedOperation({
        apiPackage,
        apiInterface: server,
        operation: saveAll,
        parameters: [],
        resultType,
    });
    if (!adapter) throw new Error('Expected an adapter for the supported Pumpkin result operation');
    expect(adapter).toContain('__staticHermesWitError');

    const module = (await importFacade(generateEsmFacade(server))) as unknown as { saveAll(): unknown };
    globalState.__pumpkinHost = {
        server: { saveAll: () => ({ __staticHermesWitError: 'disk full' }) },
    };

    expect(() => module.saveAll()).toThrow('Pumpkin API error: disk full');
});

it('wraps resources nested in Pumpkin results and variants with their resource classes', async () => {
    const playerType: ResolvedWitType = {
        kind: 'resource',
        name: 'player',
        interfaceName: 'player',
        packageName: 'pumpkin:plugin',
        interfaceSpecifier: 'pumpkin:plugin/player@0.1.0',
        interfaceDependencies: [],
    };
    const player = {
        ...apiInterface('player', 'pumpkin:plugin/player@0.1.0', []),
        resources: [{ name: 'player', functions: [operation('get-name')] }],
    };
    const server = {
        ...apiInterface('server', 'pumpkin:plugin/server@0.1.0', [
            {
                ...operation('find-sender'),
                resolvedResult: {
                    kind: 'variant',
                    name: 'sender',
                    interfaceName: 'server',
                    packageName: 'pumpkin:plugin',
                    interfaceSpecifier: 'pumpkin:plugin/server@0.1.0',
                    interfaceDependencies: [],
                    cases: [
                        { name: 'player', type: 'player', resolvedType: playerType },
                        { name: 'console', type: '' },
                    ],
                },
            },
            {
                ...operation('parse-player'),
                resolvedResult: { kind: 'result', ok: playerType, error: { kind: 'primitive', name: 'string' } },
            },
        ]),
        dependencies: ['player'],
    };
    const module = (await importFacade(generateEsmFacade(server, [server, player]))) as unknown as {
        findSender(): { tag: string; val: { getName(): string } };
        parsePlayer(): { getName(): string };
    };
    const nativePlayer = { getName: () => 'Steve' };
    globalState.__pumpkinHost = {
        server: { findSender: () => ({ tag: 'player', val: nativePlayer }), parsePlayer: () => nativePlayer },
    };

    const sender = module.findSender();
    const parsed = module.parsePlayer();
    expect(sender.tag).toBe('player');
    expect(sender.val.constructor.name).toBe('Player');
    expect(sender.val.getName()).toBe('Steve');
    expect(parsed.constructor.name).toBe('Player');
    globalState.__staticHermesPluginUnloading = true;
    expect(() => sender.val.getName()).toThrow('Pumpkin host calls are unavailable during plugin unload');
    expect(() => parsed.getName()).toThrow('Pumpkin host calls are unavailable during plugin unload');
});

it('wraps WASI resource lifetimes and turns native error markers into JavaScript errors', async () => {
    const wasiInterface = wasiApiInterface();
    const module = (await importFacade(generateWasiEsmFacade(wasiInterface))) as unknown as WasiFacade;
    const calls: string[] = [];
    const nativeResource = {
        __isValid: true,
        read(value: string) {
            calls.push(value);
            return value.toUpperCase();
        },
        drop() {
            this.__isValid = false;
        },
    };
    globalState.__pumpkinWasiFilesystemTypes = {
        lookup: () => ({ __staticHermesWitError: { tag: 'not-found' } }),
        file: { constructor: () => nativeResource },
    };

    const file = new module.File();
    expect(file.read('hello')).toBe('HELLO');
    expect(calls).toEqual(['hello']);
    expect(() => module.lookup()).toThrow('WASI error: not-found');
    const savedRead = file.read;
    file[Symbol.dispose]();
    expect(nativeResource.__isValid).toBe(false);
    expect(() => file.read('again')).toThrow('Cannot use a disposed or transferred resource');
    expect(() => savedRead('again')).toThrow('Cannot use a disposed or transferred resource');
    expect(calls).toEqual(['hello']);
});

async function importFacade(source: string): Promise<Record<string, unknown>> {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'static-hermes-facade-'));
    directories.push(directory);
    const filename = path.join(directory, 'facade.mjs');
    fs.writeFileSync(filename, source);
    return (await import(pathToFileURL(filename).href)) as Record<string, unknown>;
}

interface SchedulerFacade {
    cancelTask(id: number): string;
    scheduleTask(): string;
}

interface WasiFacade {
    File: new () => {
        read(value: string): string;
        [Symbol.dispose](): void;
    };
    lookup(): unknown;
}

function apiInterface(name: string, specifier: string, functions: WitFunction[]): WitApiInterface {
    return {
        name,
        specifier,
        packageName: 'pumpkin:plugin',
        version: '0.1.0',
        functions,
        resources: [],
        records: [],
        variants: [],
        enums: [],
        flags: [],
        types: [],
        dependencies: [],
    };
}

function wasiApiInterface(): WitWasiInterface {
    return {
        ...apiInterface('types', 'wasi:filesystem/types@0.2.3', [operation('lookup')]),
        packageName: 'wasi:filesystem',
        version: '0.2.3',
        dependencies: [],
        dependencyTypes: {},
        resources: [
            {
                name: 'file',
                functions: [operation('constructor'), operation('read')],
            },
        ],
    };
}

function operation(name: string): WitFunction {
    return { name, isStatic: false, parameters: [], result: '' };
}

function restoreGlobal(name: string, value: unknown): void {
    if (value === undefined) delete globalState[name];
    else globalState[name] = value;
}
