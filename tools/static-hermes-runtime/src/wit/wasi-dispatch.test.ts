import { expect, it } from 'vitest';
import type { WitAnalysis } from './analysis.ts';
import { generateWitApiFunctionForResolvedOperation } from './native-adapters.ts';
import type { ResolvedWitType, WitApiPackage, WitFunction, WitWasiAdapterPlan, WitWasiInterface } from './types.ts';
import { generateWasiAdapterDispatch } from './wasi-dispatch.ts';

it('guards owned input and output WIT values before conversion can throw', () => {
    const interfaceSpecifier = 'wasi:test/api@0.2.3';
    const apiInterface: WitWasiInterface = {
        packageName: 'wasi:test',
        version: '0.2.3',
        name: 'api',
        specifier: interfaceSpecifier,
        functions: [],
        resources: [],
        records: [],
        variants: [],
        enums: [],
        flags: [],
        types: [],
        dependencies: [],
        dependencyTypes: {}
    };
    const apiPackage: WitApiPackage = {
        packageName: 'wasi:test',
        version: '0.2.3',
        interfaces: [apiInterface]
    };
    const listOfStrings: ResolvedWitType = {
        kind: 'list',
        item: { kind: 'primitive', name: 'string' },
        packageName: 'wasi:test',
        interfaceSpecifier
    };
    const operation: WitFunction = {
        name: 'echo',
        isStatic: false,
        parameters: [{ name: 'names', type: 'list<string>' }],
        result: 'string'
    };

    const generated = generateWitApiFunctionForResolvedOperation({
        apiPackage,
        apiInterface,
        operation,
        parameters: [{ name: 'names', type: 'list<string>', resolvedType: listOfStrings }],
        resultType: { kind: 'primitive', name: 'string' }
    });

    if (generated === undefined) throw new Error('Expected an adapter for the supported WIT operation');
    const inputDeclaration = generated.indexOf('plugin_list_string_t argument0{argument0Data, argument0Size};');
    const inputGuard = generated.indexOf('WitScopeGuard argument0Cleanup');
    const inputLoop = generated.indexOf('for (std::size_t argument0Index');
    expect(inputGuard).toBeGreaterThan(inputDeclaration);
    expect(inputGuard).toBeLessThan(inputLoop);
    expect(generated).toContain('plugin_list_string_free(&argument0);');
    const itemGuard = generated.indexOf('WitScopeGuard argument0ItemCleanup');
    const itemAssignment = generated.indexOf('argument0Data[argument0Index] = argument0Item;');
    const itemGuardRelease = generated.indexOf('argument0ItemCleanup.release();');
    expect(itemGuard).toBeGreaterThan(inputLoop);
    expect(itemGuardRelease).toBeGreaterThan(itemAssignment);

    const outputDeclaration = generated.indexOf('plugin_string_t result{};');
    const outputGuard = generated.indexOf('WitScopeGuard resultCleanup');
    const outputCall = generated.indexOf('wasi_test_api_echo(&argument0, &result);');
    const outputConversion = generated.indexOf('wasiStringValue(result)');
    expect(outputGuard).toBeGreaterThan(outputDeclaration);
    expect(outputGuard).toBeLessThan(outputCall);
    expect(outputGuard).toBeLessThan(outputConversion);
    expect(generated).toContain('plugin_string_free(&result);');
});

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
