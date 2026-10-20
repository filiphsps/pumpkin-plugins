import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { planApiAdapterOperations, type WitAnalysis } from './analysis.ts';
import { generateWitOutputs } from './generation.ts';
import { generateWitApiFunctionForResolvedOperation } from './native-adapters.ts';
import { generatePumpkinMethodDispatch } from './pumpkin-dispatch.ts';
import type {
    ResolvedWitType,
    WitApiInterface,
    WitApiPackage,
    WitFunction,
    WitWasiAdapterPlan,
    WitWasiInterface,
} from './types.ts';
import { generateWasiAdapterDispatch } from './wasi-dispatch.ts';

const temporaryDirectories: string[] = [];

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

it('validates signed and unsigned WIT integer inputs without changing float conversions', () => {
    const cases = [
        { name: 's8', cType: 'int8_t' },
        { name: 'u8', cType: 'uint8_t' },
        { name: 's16', cType: 'int16_t' },
        { name: 'u16', cType: 'uint16_t' },
        { name: 's32', cType: 'int32_t' },
        { name: 'u32', cType: 'uint32_t' },
    ];

    for (const { name, cType } of cases) {
        const generated = generateIntegerInputAdapter(name);
        expect(generated).toContain(`wasiInputInteger<${cType}>(rt, args[0], ${JSON.stringify(name)})`);
    }

    expect(generateIntegerInputAdapter('f32')).toContain('static_cast<float>(args[0].asNumber())');
    expect(generateIntegerInputAdapter('f64')).toContain('static_cast<double>(args[0].asNumber())');
});

it('rejects out-of-range and fractional WIT integer inputs while accepting valid boundaries', () => {
    const templatePath = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        '../../src/component/templates/runtime-shim.template',
    );
    const template = fs.readFileSync(templatePath, 'utf8');
    const helper = extractCppFunction(template, 'template <typename Integer>\nInteger wasiInputInteger(');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'static-hermes-wit-integer-'));
    temporaryDirectories.push(root);
    const source = `
#include <cassert>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <limits>
#include <stdexcept>
#include <string>

class Runtime {};
class Value {
  public:
    explicit Value(double number) : number_(number) {}
    double asNumber() const { return number_; }
  private:
    double number_;
};
class JSError : public std::runtime_error {
  public:
    JSError(Runtime &, const std::string &message) : std::runtime_error(message) {}
};

${helper}

template <typename Callback>
void expectInvalid(Callback callback) {
    try {
        callback();
    } catch (const JSError &) {
        return;
    }
    std::abort();
}

int main() {
    Runtime runtime;
    assert(wasiInputInteger<int8_t>(runtime, Value(-128), "s8") == -128);
    assert(wasiInputInteger<int8_t>(runtime, Value(127), "s8") == 127);
    assert(wasiInputInteger<uint8_t>(runtime, Value(0), "u8") == 0);
    assert(wasiInputInteger<uint8_t>(runtime, Value(255), "u8") == 255);
    assert(wasiInputInteger<int32_t>(runtime, Value(-2147483648.0), "s32") == INT32_MIN);
    assert(wasiInputInteger<int32_t>(runtime, Value(2147483647.0), "s32") == INT32_MAX);
    assert(wasiInputInteger<uint32_t>(runtime, Value(0), "u32") == 0);
    assert(wasiInputInteger<uint32_t>(runtime, Value(4294967295.0), "u32") == UINT32_MAX);
    expectInvalid([&] { wasiInputInteger<uint32_t>(runtime, Value(-1), "u32"); });
    expectInvalid([&] { wasiInputInteger<uint8_t>(runtime, Value(300), "u8"); });
    expectInvalid([&] { wasiInputInteger<int32_t>(runtime, Value(1.5), "s32"); });
    expectInvalid([&] { wasiInputInteger<int8_t>(runtime, Value(-128.5), "s8"); });
    expectInvalid([&] { wasiInputInteger<uint16_t>(runtime, Value(65536), "u16"); });
    expectInvalid([&] { wasiInputInteger<int16_t>(runtime, Value(std::numeric_limits<double>::infinity()), "s16"); });
}
`;
    compileAndRunCpp(root, source);
}, 20_000);

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
        dependencyTypes: {},
    };
    const apiPackage: WitApiPackage = {
        packageName: 'wasi:test',
        version: '0.2.3',
        interfaces: [apiInterface],
    };
    const listOfStrings: ResolvedWitType = {
        kind: 'list',
        item: { kind: 'primitive', name: 'string' },
        packageName: 'wasi:test',
        interfaceSpecifier,
    };
    const operation: WitFunction = {
        name: 'echo',
        isStatic: false,
        parameters: [{ name: 'names', type: 'list<string>' }],
        result: 'string',
    };

    const generated = generateWitApiFunctionForResolvedOperation({
        apiPackage,
        apiInterface,
        operation,
        parameters: [{ name: 'names', type: 'list<string>', resolvedType: listOfStrings }],
        resultType: { kind: 'primitive', name: 'string' },
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

function generateIntegerInputAdapter(typeName: string): string {
    const interfaceSpecifier = 'wasi:test/types@0.2.3';
    const operation: WitFunction = {
        name: 'accept',
        isStatic: false,
        parameters: [{ name: 'value', type: typeName }],
        result: '',
    };
    const apiInterface: WitWasiInterface = {
        packageName: 'wasi:test',
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
        dependencyTypes: {},
    };
    const apiPackage: WitApiPackage = {
        packageName: 'wasi:test',
        version: '0.2.3',
        interfaces: [apiInterface],
    };
    const generated = generateWitApiFunctionForResolvedOperation({
        apiPackage,
        apiInterface,
        operation,
        parameters: [{ name: 'value', type: typeName, resolvedType: { kind: 'primitive', name: typeName } }],
        resultType: { kind: 'unit' },
    });
    if (!generated) throw new Error(`Expected a generated adapter for WIT ${typeName}`);
    return generated;
}

function extractCppFunction(source: string, signature: string): string {
    const start = source.indexOf(signature);
    if (start < 0) throw new Error(`Runtime template is missing ${signature}`);
    const open = source.indexOf('{', start);
    if (open < 0) throw new Error(`Runtime template has no function body for ${signature}`);
    let depth = 0;
    for (let index = open; index < source.length; index++) {
        if (source[index] === '{') depth++;
        else if (source[index] === '}') {
            depth--;
            if (depth === 0) return source.slice(start, index + 1);
        }
    }
    throw new Error(`Runtime template has an unclosed function body for ${signature}`);
}

function compileAndRunCpp(root: string, source: string): void {
    const input = path.join(root, 'integer-input-contract.cpp');
    const executable = path.join(root, 'integer-input-contract');
    fs.writeFileSync(input, source);
    childProcess.execFileSync(process.env.CXX ?? 'c++', ['-std=c++17', input, '-o', executable], { stdio: 'pipe' });
    childProcess.execFileSync(executable, [], { stdio: 'pipe' });
}

it('uses the owning interface name for imported named WIT types', () => {
    const interfaceSpecifier = 'wasi:filesystem/types@0.2.3';
    const operation: WitFunction = {
        name: 'set-timestamp',
        isStatic: false,
        parameters: [
            { name: 'timestamp', type: 'datetime' },
            { name: 'error', type: 'io-error' },
        ],
        result: '',
        resolvedResult: { kind: 'unit' },
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
        dependencyTypes: {},
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
            { name: 'nanoseconds', type: 'u32', resolvedType: { kind: 'primitive' as const, name: 'u32' } },
        ],
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
                        aliasName: 'io-error',
                    },
                },
            },
        ],
        resultType: { kind: 'unit' },
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
        eventFields: [],
    };

    const generated = generateWasiAdapterDispatch([interfaceDefinition], analysis);

    expect(generated).toContain('wasi_clocks_wall_clock_datetime_t argument0{};');
    expect(generated).toContain('wasi_io_error_borrow_error_t argument1{argument1State->handle};');
    expect(generated).not.toContain('wasi_clocks_types_datetime_t');
});

it('recursively frees variant payload records without standalone wit-bindgen cleanup functions', () => {
    const interfaceSpecifier = 'wasi:http/types@0.2.3';
    const payloadRecord = (name: string, fields: Array<{ name: string; type: ResolvedWitType }>): ResolvedWitType => ({
        kind: 'record',
        name,
        interfaceName: 'types',
        packageName: 'wasi:http',
        interfaceSpecifier,
        interfaceDependencies: [],
        declaredInterface: 'types',
        fields: fields.map(({ name: fieldName, type }) => ({
            name: fieldName,
            type: 'option',
            resolvedType: type,
        })),
    });
    const errorCode: ResolvedWitType = {
        kind: 'variant',
        name: 'error-code',
        interfaceName: 'types',
        packageName: 'wasi:http',
        interfaceSpecifier,
        interfaceDependencies: [],
        declaredInterface: 'types',
        cases: [
            {
                name: 'DNS-error',
                type: 'dns-error-payload',
                resolvedType: payloadRecord('dns-error-payload', [
                    { name: 'rcode', type: { kind: 'option', item: { kind: 'primitive', name: 'string' } } },
                ]),
            },
            {
                name: 'TLS-alert-received',
                type: 'tls-alert-received-payload',
                resolvedType: payloadRecord('tls-alert-received-payload', [
                    { name: 'alert-message', type: { kind: 'option', item: { kind: 'primitive', name: 'string' } } },
                ]),
            },
            {
                name: 'HTTP-request-header-size',
                type: 'option<field-size-payload>',
                resolvedType: {
                    kind: 'option',
                    item: payloadRecord('field-size-payload', [
                        { name: 'field-name', type: { kind: 'option', item: { kind: 'primitive', name: 'string' } } },
                    ]),
                },
            },
        ],
    };
    const apiInterface: WitWasiInterface = {
        packageName: 'wasi:http',
        version: '0.2.3',
        name: 'types',
        specifier: interfaceSpecifier,
        functions: [],
        resources: [],
        records: [],
        variants: [],
        enums: [],
        flags: [],
        types: [],
        dependencies: [],
        dependencyTypes: {},
    };
    const operation: WitFunction = {
        name: 'accept-error',
        isStatic: false,
        parameters: [{ name: 'error', type: 'error-code' }],
        result: '',
        resolvedResult: { kind: 'unit' },
    };
    apiInterface.functions = [operation];
    const plan: WitWasiAdapterPlan = {
        operationId: `${interfaceSpecifier}#accept-error`,
        kind: 'function',
        apiInterface,
        operation,
        parameters: [{ name: 'error', type: 'error-code', resolvedType: errorCode }],
        resultType: { kind: 'unit' },
    };
    const analysis: WitAnalysis = {
        apiInterfaces: [],
        apiMethods: [],
        apiAdapters: [],
        wasiImports: [interfaceSpecifier],
        wasiInterfaces: [interfaceSpecifier],
        resolvedWasiInterfaces: [apiInterface],
        wasiMethods: [plan.operationId],
        wasiFeatures: [],
        wasiAdapters: [plan],
        eventFields: [],
    };
    const apiInterfaceFixture = (name: string, enums: WitApiInterface['enums']): WitApiInterface => ({
        packageName: 'pumpkin:api',
        version: '1.0.0',
        name,
        specifier: `pumpkin:api/${name}@1.0.0`,
        functions: [],
        resources: [],
        records: [],
        variants: [],
        enums,
        flags: [],
        types: [],
        dependencies: [],
        dependencyTypes: {},
    });
    const apiPackage: WitApiPackage = {
        packageName: 'pumpkin:api',
        version: '1.0.0',
        interfaces: [
            apiInterfaceFixture('event', [
                { name: 'event-type', values: ['join'] },
                { name: 'event-priority', values: ['normal'] },
            ]),
            apiInterfaceFixture('game-rules', [{ name: 'game-rule', values: ['keep-inventory'] }]),
            apiInterfaceFixture('common', [{ name: 'named-color', values: ['white'] }]),
        ],
    };
    const pluginHeader = [
        '#define PUMPKIN_PLUGIN_EVENT_EVENT_TYPE_JOIN 1',
        '#define PUMPKIN_PLUGIN_EVENT_EVENT_PRIORITY_NORMAL 2',
        '#define PUMPKIN_PLUGIN_GAME_RULES_GAME_RULE_KEEP_INVENTORY 3',
        '#define PUMPKIN_PLUGIN_COMMON_NAMED_COLOR_WHITE 4',
        'void plugin_option_string_free(plugin_option_string_t *value);',
        'void wasi_http_types_error_code_free(wasi_http_types_error_code_t *value);',
        'void wasi_http_types_option_field_size_payload_free(wasi_http_types_option_field_size_payload_t *value);',
    ].join('\n');
    const markers = [
        '/* <PUMPKIN_WASI_RUNTIME> */',
        '/* <PUMPKIN_WASI_INITIALIZATION> */',
        '/* <PUMPKIN_WIT_SIMPLE_METHODS> */',
        '/* <PUMPKIN_WIT_EVENT_DISPATCH> */',
        '/* <PUMPKIN_WIT_EVENT_RESULT> */',
    ];
    const input = { analysis, apiPackage, wasiInterfaces: [apiInterface], pluginHeader };
    const generated = generateWitOutputs({ ...input, runtimeTemplate: markers.join('\n') }).runtimeSource;
    // A template without the event-result marker would silently drop blocking event results.
    expect(() => generateWitOutputs({ ...input, runtimeTemplate: markers.slice(0, -1).join('\n') })).toThrow(
        'PUMPKIN_WIT_EVENT_RESULT',
    );

    expect(generated).toContain('wasi_http_types_error_code_free(&argument0);');
    expect(generated).toContain('plugin_option_string_free(&argument0DNSErrorRcode);');
    expect(generated).toContain('plugin_option_string_free(&argument0TLSAlertReceivedAlertMessage);');
    expect(generated).toContain('wasi_http_types_option_field_size_payload_free(&argument0HTTPRequestHeaderSize);');
    expect(generated).toContain('plugin_option_string_free(&argument0HTTPRequestHeaderSizeValueFieldName);');
    expect(generated).not.toContain('wasi_http_types_dns_error_payload_free');
    expect(generated).not.toContain('wasi_http_types_tls_alert_received_payload_free');
    expect(generated).not.toContain('wasi_http_types_field_size_payload_free');
});

it('drops Pumpkin resources returned inside lists and options', () => {
    const playerType: ResolvedWitType = {
        kind: 'resource',
        name: 'player',
        interfaceName: 'player',
        packageName: 'pumpkin:plugin',
        interfaceSpecifier: 'pumpkin:plugin/player@0.1.0',
        interfaceDependencies: [],
    };
    const pumpkinInterface = (
        name: string,
        details: Pick<WitApiInterface, 'functions' | 'resources'>,
    ): WitApiInterface => ({
        packageName: 'pumpkin:plugin',
        name,
        specifier: `pumpkin:plugin/${name}@0.1.0`,
        records: [],
        variants: [],
        enums: [],
        flags: [],
        types: [],
        dependencies: [],
        ...details,
    });
    const apiPackage: WitApiPackage = {
        packageName: 'pumpkin:plugin',
        version: '0.1.0',
        interfaces: [
            pumpkinInterface('server', {
                resources: [],
                functions: [
                    {
                        name: 'get-all-players',
                        isStatic: false,
                        parameters: [],
                        result: 'list<player>',
                        resolvedResult: { kind: 'list', item: playerType },
                    },
                    {
                        name: 'get-player-by-name',
                        isStatic: false,
                        parameters: [],
                        result: 'option<player>',
                        resolvedResult: { kind: 'option', item: playerType },
                    },
                ],
            }),
            pumpkinInterface('player', { functions: [], resources: [{ name: 'player', functions: [] }] }),
        ],
    };
    const analysis: WitAnalysis = {
        apiInterfaces: apiPackage.interfaces.map(({ specifier }) => specifier),
        apiMethods: ['server.get-all-players', 'server.get-player-by-name'],
        apiAdapters: planApiAdapterOperations(apiPackage, ['server.get-all-players', 'server.get-player-by-name']),
        wasiImports: [],
        wasiInterfaces: [],
        resolvedWasiInterfaces: [],
        wasiMethods: [],
        wasiFeatures: [],
        wasiAdapters: [],
        eventFields: [],
    };
    const drop = extractCppFunction(
        generatePumpkinMethodDispatch(apiPackage, analysis),
        'void generatedWitDropResource(',
    );
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'static-hermes-wit-drop-'));
    temporaryDirectories.push(root);
    compileAndRunCpp(
        root,
        `
#include <cstdint>
#include <stdexcept>
#include <string>

struct pumpkin_plugin_player_own_player_t { int32_t __handle; };
int32_t droppedPlayer = 0;
void pumpkin_plugin_player_player_drop_own(pumpkin_plugin_player_own_player_t player) { droppedPlayer = player.__handle; }

${drop}

int main() {
    generatedWitDropResource("player", "player", 7);
    if (droppedPlayer != 7) return 1;
    try {
        generatedWitDropResource("player", "missing", 8);
    } catch (const std::exception &) {
        return 0;
    }
    return 2;
}
`,
    );
}, 20_000);

it('reports a failed result with no error payload through the error marker', () => {
    const apiInterface: WitApiInterface = {
        packageName: 'pumpkin:plugin',
        name: 'ipc',
        specifier: 'pumpkin:plugin/ipc@0.1.0',
        functions: [],
        resources: [],
        records: [],
        variants: [],
        enums: [],
        flags: [],
        types: [],
    };
    const generated = generateWitApiFunctionForResolvedOperation({
        apiPackage: { packageName: 'pumpkin:plugin', version: '0.1.0', interfaces: [apiInterface] },
        apiInterface,
        operation: { name: 'send', isStatic: false, parameters: [], result: 'result<u32>' },
        parameters: [],
        resultType: { kind: 'result', ok: { kind: 'primitive', name: 'u32' }, error: { kind: 'unit' } },
    });

    if (generated === undefined) throw new Error('Expected an adapter for the supported WIT operation');
    const failure = generated.slice(generated.indexOf('if (!callSucceeded)'));
    expect(failure).toContain('"__staticHermesWitError"');
    expect(failure).not.toContain('"tag"');
});
