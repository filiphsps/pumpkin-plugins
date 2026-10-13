import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { generateEsmFacade, generateWasiEsmFacade } from './facades.ts';
import type { WitApiInterface, WitFunction, WitWasiInterface } from './types.ts';

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
        operation('schedule-task')
    ]);
    const module = (await importFacade(generateEsmFacade(scheduler))) as unknown as SchedulerFacade;
    globalState.__pumpkinHost = {
        scheduler: {
            cancelTask: (id: number) => `cancelled:${id}`,
            scheduleTask: () => 'scheduled'
        }
    };
    globalState.__staticHermesPluginUnloading = true;

    expect(module.cancelTask(7)).toBe('cancelled:7');
    expect(() => module.scheduleTask()).toThrow('Pumpkin host calls are unavailable during plugin unload');
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
        }
    };
    globalState.__pumpkinWasiFilesystemTypes = {
        lookup: () => ({ __staticHermesWasiError: { tag: 'not-found' } }),
        file: { constructor: () => nativeResource }
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
    lookup(): unknown;
    File: new () => {
        read(value: string): string;
        [Symbol.dispose](): void;
    };
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
        dependencies: []
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
                functions: [operation('constructor'), operation('read')]
            }
        ]
    };
}

function operation(name: string): WitFunction {
    return { name, isStatic: false, parameters: [], result: '' };
}

function restoreGlobal(name: string, value: unknown): void {
    if (value === undefined) delete globalState[name];
    else globalState[name] = value;
}
