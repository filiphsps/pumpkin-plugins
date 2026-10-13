import * as esbuild from 'esbuild';
import { expect, it } from 'vitest';
import { analyzeWitUsage, selectWitEventFields } from '../src/wit/analysis.ts';
import { parseWitToolsJson } from '../src/wit/model.ts';
import { resolveWitDocument } from '../src/wit/resolver.ts';
import type { WitApiPackage } from '../src/wit/types.ts';

const wasiGraph = {
    worlds: [{ name: 'plugin', package: 0, imports: { 'interface-0': { interface: { id: 0 } } } }],
    interfaces: [
        {
            name: 'handler',
            package: 1,
            types: { pollable: 0 },
            functions: {
                connect: {
                    name: 'connect',
                    kind: 'freestanding',
                    params: [],
                    result: null,
                    stability: { unstable: { feature: 'sockets' } }
                }
            }
        },
        {
            name: 'poll',
            package: 2,
            types: {},
            functions: { ready: { name: 'ready', kind: 'freestanding', params: [], result: 'bool' } }
        }
    ],
    types: [{ name: 'pollable', kind: 'resource', owner: { interface: 1 } }],
    packages: [
        { name: 'example:plugin@1.0.0', interfaces: {}, worlds: { plugin: 0 } },
        { name: 'wasi:net@1.0.0', interfaces: { handler: 0 }, worlds: {} },
        { name: 'wasi:io@1.0.0', interfaces: { poll: 1 }, worlds: {} }
    ]
};

const apiGraph = {
    worlds: [
        {
            name: 'plugin',
            package: 0,
            imports: { 'interface-0': { interface: { id: 0 } } }
        }
    ],
    interfaces: [
        {
            name: 'logging',
            package: 1,
            types: {},
            functions: {
                log: {
                    name: 'log',
                    kind: 'freestanding',
                    params: [{ name: 'message', type: 'string' }],
                    result: null
                },
                warn: {
                    name: 'warn',
                    kind: 'freestanding',
                    params: [{ name: 'message', type: 'string' }],
                    result: null
                }
            }
        }
    ],
    types: [],
    packages: [
        { name: 'pumpkin:plugin@0.1.0', interfaces: {}, worlds: { plugin: 0 } },
        { name: 'pumpkin:plugin-api@0.1.0', interfaces: { logging: 0 }, worlds: {} }
    ]
};

it('keeps Pumpkin API adapters when esbuild inlines dynamic facade access into an IIFE', async () => {
    const bundle = await esbuild.build({
        stdin: {
            contents: `
                import * as logging from 'pumpkin:plugin/logging@0.1.0';
                const method = getOperationName();
                logging[method]('message');
            `,
            loader: 'ts',
            resolveDir: process.cwd(),
            sourcefile: 'plugin.ts'
        },
        bundle: true,
        format: 'iife',
        globalName: '__pumpkinPlugin',
        minify: true,
        write: false,
        plugins: [
            {
                name: 'pumpkin-api-facade-fixture',
                setup(build) {
                    build.onResolve({ filter: /^pumpkin:plugin\// }, ({ path }) => ({
                        path,
                        namespace: 'pumpkin-api-fixture'
                    }));
                    build.onLoad({ filter: /.*/, namespace: 'pumpkin-api-fixture' }, () => ({
                        contents:
                            'export function log(message) { return message; } export function warn(message) { return message; }',
                        loader: 'js'
                    }));
                }
            }
        ]
    });
    const bundleSource = bundle.outputFiles[0]?.text;
    expect(bundleSource).toBeDefined();
    if (bundleSource === undefined) throw new Error('esbuild did not emit the integration fixture bundle');
    expect(bundleSource).not.toMatch(/\bimport\b/);

    const resolved = resolveWitDocument(parseWitToolsJson(JSON.stringify(apiGraph)));
    const analysis = analyzeWitUsage(resolved, { bundleSource });

    expect(analysis.apiMethods).toEqual(['logging.log', 'logging.warn']);
    expect(analysis.apiAdapters.map(({ operationId }) => operationId)).toEqual(['logging.log', 'logging.warn']);
});

it('selects WASI imports, dependency closure, used operations, and their features', () => {
    const resolved = resolveWitDocument(parseWitToolsJson(JSON.stringify(wasiGraph)));
    const result = analyzeWitUsage(resolved, {
        bundleSource: '',
        pluginImportOrder: ['wasi:net/handler@1.0.0'],
        wasiImports: ['wasi:net/handler@1.0.0'],
        wasiMethods: ['wasi:net/handler@1.0.0#connect'],
        apiMethods: []
    });

    expect(result.wasiInterfaces).toEqual(['wasi:net/handler@1.0.0', 'wasi:io/poll@1.0.0']);
    expect(result.wasiMethods).toEqual(['wasi:net/handler@1.0.0#connect']);
    expect(result.wasiFeatures).toEqual(['sockets']);
    expect(result.wasiAdapters.map(({ operationId }) => operationId)).toEqual(['wasi:net/handler@1.0.0#connect']);
});

it('selects features for every WASI operation when method analysis is omitted', () => {
    const resolved = resolveWitDocument(parseWitToolsJson(JSON.stringify(wasiGraph)));
    const result = analyzeWitUsage(resolved, {
        bundleSource: '',
        wasiImports: ['wasi:net/handler@1.0.0'],
        apiMethods: []
    });

    expect(result.wasiMethods).toEqual(['wasi:net/handler@1.0.0#connect', 'wasi:io/poll@1.0.0#ready']);
    expect(result.wasiFeatures).toEqual(['sockets']);
});

it('rejects an explicitly selected WASI operation absent from the imported graph', () => {
    const resolved = resolveWitDocument(parseWitToolsJson(JSON.stringify(wasiGraph)));

    expect(() =>
        analyzeWitUsage(resolved, {
            bundleSource: '',
            wasiImports: ['wasi:net/handler@1.0.0'],
            wasiMethods: ['wasi:net/handler@1.0.0#missing']
        })
    ).toThrow('WASI operation used by the plugin is not declared in WIT: wasi:net/handler@1.0.0#missing');
});

it.each([
    '"join"; const { playerId } = data;',
    '"join"; Object.keys(data);',
    '"join"; const copy = { ...data };',
    '"join"; data[field];',
    'registerEvent(["jo", "in"].join(""), callback);'
])('preserves complete event payloads for JavaScript access: %s', (bundleSource) => {
    const apiPackage: WitApiPackage = {
        packageName: 'pumpkin:plugin',
        version: '0.1.0',
        interfaces: [
            {
                name: 'event',
                specifier: 'pumpkin:plugin/event@0.1.0',
                functions: [],
                resources: [],
                records: [
                    {
                        name: 'join-data',
                        fields: [
                            { name: 'player-id', type: 'u32', resolvedType: { kind: 'primitive', name: 'u32' } },
                            { name: 'message', type: 'string', resolvedType: { kind: 'primitive', name: 'string' } }
                        ]
                    }
                ],
                variants: [{ name: 'event', cases: [{ name: 'join', type: 'join-data' }] }],
                enums: [],
                flags: [],
                types: []
            }
        ]
    };

    expect(selectWitEventFields(apiPackage, bundleSource)).toEqual([
        { event: 'join', record: 'join-data', fields: ['player-id', 'message'] }
    ]);
});
