import { expect, it } from 'vitest';
import type { WitAnalysis } from './analysis.ts';
import type { WitFunction, WitWasiAdapterPlan, WitWasiInterface } from './types.ts';
import { generateWasiAdapterDispatch } from './wasi-dispatch.ts';

it('uses the owning interface name for imported named WIT types', () => {
    const interfaceSpecifier = 'wasi:filesystem/types@0.2.3';
    const operation: WitFunction = {
        name: 'set-timestamp',
        isStatic: false,
        parameters: [
            { name: 'timestamp', type: 'datetime' },
            { name: 'error', type: 'io-error' }
        ],
        result: '',
        resolvedResult: { kind: 'unit' }
    };
    const interfaceDefinition: WitWasiInterface = {
        packageName: 'wasi:filesystem',
        version: '0.2.3',
        name: 'types',
        specifier: interfaceSpecifier,
        functions: [operation],
        resources: [],
        records: [],
        variants: [],
        enums: [],
        flags: [],
        types: [],
        dependencies: [],
        dependencyTypes: {}
    };
    const datetime = {
        kind: 'record' as const,
        name: 'datetime',
        interfaceName: 'wall-clock',
        packageName: 'wasi:clocks',
        interfaceSpecifier: 'wasi:clocks/wall-clock@0.2.3',
        interfaceDependencies: [],
        declaredInterface: 'types',
        aliasName: 'datetime',
        fields: [
            { name: 'seconds', type: 'u64', resolvedType: { kind: 'primitive' as const, name: 'u64' } },
            { name: 'nanoseconds', type: 'u32', resolvedType: { kind: 'primitive' as const, name: 'u32' } }
        ]
    };
    const plan: WitWasiAdapterPlan = {
        operationId: `${interfaceSpecifier}#set-timestamp`,
        kind: 'function',
        apiInterface: interfaceDefinition,
        operation,
        parameters: [
            { name: 'timestamp', type: 'datetime', resolvedType: datetime },
            {
                name: 'error',
                type: 'io-error',
                resolvedType: {
                    kind: 'borrow',
                    item: {
                        kind: 'resource',
                        name: 'error',
                        interfaceName: 'error',
                        packageName: 'wasi:io',
                        interfaceSpecifier: 'wasi:io/error@0.2.3',
                        interfaceDependencies: [],
                        declaredInterface: 'types',
                        aliasName: 'io-error'
                    }
                }
            }
        ],
        resultType: { kind: 'unit' }
    };
    const analysis: WitAnalysis = {
        apiInterfaces: [],
        apiMethods: [],
        apiAdapters: [],
        wasiImports: [interfaceSpecifier],
        wasiInterfaces: [interfaceSpecifier],
        resolvedWasiInterfaces: [interfaceDefinition],
        wasiMethods: [plan.operationId],
        wasiFeatures: [],
        wasiAdapters: [plan],
        eventFields: []
    };

    const generated = generateWasiAdapterDispatch([interfaceDefinition], analysis);

    expect(generated).toContain('wasi_clocks_wall_clock_datetime_t argument0{};');
    expect(generated).toContain('wasi_io_error_borrow_error_t argument1{argument1State->handle};');
    expect(generated).not.toContain('wasi_clocks_types_datetime_t');
});
