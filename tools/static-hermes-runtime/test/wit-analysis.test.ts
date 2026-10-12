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

it('selects event fields from quoted event tags and bundle property accesses', () => {
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

    expect(selectWitEventFields(apiPackage, '"join"; data.playerId;')).toEqual([
        { event: 'join', record: 'join-data', fields: ['player-id'] }
    ]);
});
