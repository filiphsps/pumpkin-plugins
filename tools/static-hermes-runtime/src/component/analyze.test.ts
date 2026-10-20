import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { analyzeComponentWit } from './analyze.ts';

const mocks = vi.hoisted(() => ({ execFileSync: vi.fn() }));
vi.mock('node:child_process', () => ({ execFileSync: mocks.execFileSync }));

// wasm-tools JSON for a plugin world that imports logging and the event variant.
const witGraph = {
    worlds: [
        {
            name: 'plugin',
            package: 0,
            imports: { 'interface-0': { interface: { id: 0 } }, 'interface-1': { interface: { id: 1 } } },
        },
    ],
    interfaces: [
        {
            name: 'logging',
            package: 0,
            types: {},
            functions: {
                log: { name: 'log', kind: 'freestanding', params: [{ name: 'message', type: 'string' }], result: null },
                warn: {
                    name: 'warn',
                    kind: 'freestanding',
                    params: [{ name: 'message', type: 'string' }],
                    result: null,
                },
            },
        },
        { name: 'event', package: 0, types: { 'join-data': 0, 'leave-data': 1, event: 2 }, functions: {} },
    ],
    types: [
        {
            name: 'join-data',
            kind: { record: { fields: [{ name: 'player-id', type: 'u32' }] } },
            owner: { interface: 1 },
        },
        {
            name: 'leave-data',
            kind: { record: { fields: [{ name: 'player-id', type: 'u32' }] } },
            owner: { interface: 1 },
        },
        {
            name: 'event',
            kind: {
                variant: {
                    cases: [
                        { name: 'join', type: 0 },
                        { name: 'leave', type: 1 },
                    ],
                },
            },
            owner: { interface: 1 },
        },
    ],
    packages: [{ name: 'pumpkin:plugin@0.1.0', interfaces: { logging: 0, event: 1 }, worlds: { plugin: 0 } }],
};

let wit = '';

beforeEach(() => {
    wit = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'static-hermes-analyze-')), 'wit');
    fs.mkdirSync(wit);
    fs.writeFileSync(
        path.join(wit, 'plugin.wit'),
        'package pumpkin:plugin@0.1.0;\nworld plugin {\n    import logging;\n    import event;\n}\n',
    );
    vi.stubEnv('WASM_TOOLS', '/toolchain/wasm-tools');
    mocks.execFileSync.mockReset().mockReturnValue(JSON.stringify(witGraph));
});

afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(path.dirname(wit), { recursive: true, force: true });
});

it('includes every imported API operation and event when nothing is selected', () => {
    const { analysis, apiPackage } = analyzeComponentWit({ wit, wasiImports: [] });

    expect(apiPackage.interfaces.map(({ name }) => name)).toEqual(expect.arrayContaining(['logging', 'event']));
    expect(analysis.apiMethods).toEqual(['logging.log', 'logging.warn']);
    expect(analysis.eventFields.map(({ event }) => event)).toEqual(['join', 'leave']);
});

it('keeps only the selected API operations and events', () => {
    const { analysis } = analyzeComponentWit({
        wit,
        wasiImports: [],
        apiMethods: ['logging.warn'],
        eventTypes: ['leave'],
    });

    expect(analysis.apiMethods).toEqual(['logging.warn']);
    expect(analysis.eventFields).toEqual([{ event: 'leave', record: 'leave-data', fields: ['player-id'] }]);
});

it('treats explicit empty selections as selecting nothing', () => {
    const { analysis } = analyzeComponentWit({ wit, wasiImports: [], apiMethods: [], wasiMethods: [], eventTypes: [] });

    expect(analysis.apiMethods).toEqual([]);
    expect(analysis.wasiMethods).toEqual([]);
    expect(analysis.eventFields).toEqual([]);
});
