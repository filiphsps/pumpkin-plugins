import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { digestWitDirectory, ensurePumpkinWit, parsePumpkinWitPin } from '@pumpkin-plugins/pumpkin-api/wit';
import { CAPABILITIES, wasiInterfaces } from '@pumpkin-plugins/wasi-capabilities';
import { afterEach, expect, it } from 'vitest';
import { cacheDir } from '../../build/src/repo.ts';
import { ensureWasiWit, readLock } from '../../build/src/wasi-wit.ts';
import { prepareWit } from '../../build/src/wit.ts';
import { PUMPKIN_RELEASE } from '../../test-harness/src/pumpkin-version.ts';
import { setupHermesToolchainEnvironment } from '../src/hermes/toolchain-environment.ts';
import { analyzeWitUsage } from '../src/wit/analysis.ts';
import { emitPumpkinMethodDispatch, emitWasiAdapterDispatch } from '../src/wit/emitters.ts';
import { generateWitOutputs, readGeneratedFreeFunctions } from '../src/wit/generation.ts';
import { readInterfaceDeclarationOrder, readPluginImportOrder, readWitToolsDocument } from '../src/wit/parser.ts';
import { resolvePluginApi, resolveWasiImports, resolveWitDocument } from '../src/wit/resolver.ts';
import {
    generateEsmFacade,
    generateWasiAdapterDispatch,
    generateWasiEsmFacade,
    generateWitEventDispatch,
    generateWitSimpleMethodDispatch,
    planWasiAdapterDispatch,
    readWasiWitImports,
    readWitPackage,
} from './oracles/wit-api.mjs';

const directories = [];
const runtimeRoot = path.resolve(import.meta.dirname, '..');
const apiRoot = path.dirname(createRequire(import.meta.url).resolve('@pumpkin-plugins/pumpkin-api/package.json'));
const witLockFile = path.join(apiRoot, 'wit.lock.json');

afterEach(() => {
    for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

it('generates facades and native adapters for the full pinned Pumpkin and WASI WIT surface', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'static-hermes-wit-coverage-'));
    directories.push(directory);
    const apiWitDir = ensurePumpkinWit({
        lockFile: witLockFile,
        cacheRoot: cacheDir(import.meta.dirname),
    });
    const sourceWit = parsePumpkinWitPin(fs.readFileSync(witLockFile, 'utf8'), witLockFile);

    const lock = readLock();
    const wasiWit = await ensureWasiWit({ cacheDir: cacheDir(import.meta.dirname), lock });
    const imports = wasiInterfaces(Object.keys(CAPABILITIES));
    const witDir = prepareWit({
        apiWit: apiWitDir,
        target: path.join(directory, 'wit'),
        interfaces: imports,
        wasiWit,
        wasiFiles: Object.keys(lock.files),
    });
    const apiPackage = readWitPackage(witDir);
    const wasiPackage = readWasiWitImports(witDir);

    const apiMethods = apiPackage.interfaces.flatMap((apiInterface) => [
        ...apiInterface.functions.map((operation) => `${apiInterface.name}.${operation.name}`),
        ...apiInterface.resources.flatMap((resource) =>
            resource.functions.map((operation) => `${apiInterface.name}.${resource.name}.${operation.name}`),
        ),
    ]);
    const operationInventoryPath = path.join(runtimeRoot, 'test/fixtures/pumpkin-api-operation-inventory.json');
    const operationInventory = JSON.parse(fs.readFileSync(operationInventoryPath, 'utf8'));
    expect(operationInventory).toMatchObject({
        apiPackage: '@pumpkin-plugins/pumpkin-api',
        witPackage: `${apiPackage.packageName}@${apiPackage.version}`,
        sourceWit,
        sourceWitSha256: digestWitDirectory(apiWitDir),
        pumpkinRelease: PUMPKIN_RELEASE,
        operationCount: apiMethods.length,
    });
    const mappedOperations = operationInventory.operations.map(({ operationId }) => operationId).sort();
    expect(mappedOperations).toEqual([...apiMethods].sort());
    const wasiMethods = wasiPackage.interfaces.flatMap((apiInterface) => [
        ...apiInterface.functions.map((operation) => `${apiInterface.specifier}#${operation.name}`),
        ...apiInterface.resources.flatMap((resource) =>
            resource.functions.map((operation) => `${apiInterface.specifier}#${resource.name}.${operation.name}`),
        ),
    ]);

    const pumpkinDispatch = generateWitSimpleMethodDispatch(apiPackage, '', apiMethods);
    const wasiPlan = planWasiAdapterDispatch(wasiPackage.interfaces, wasiPackage.interfaces, wasiMethods);
    const wasiDispatch = generateWasiAdapterDispatch(wasiPackage.interfaces, wasiPackage.interfaces, wasiMethods);

    expect(wasiPlan.map(({ operationId }) => operationId)).toEqual(wasiMethods);
    expect(count(pumpkinDispatch, /hostFunction\(runtime,/g)).toBe(apiMethods.length);
    expect(count(wasiDispatch, /hostFunction\(runtime,/g)).toBe(wasiMethods.length);

    for (const [index, apiInterface] of apiPackage.interfaces.entries()) {
        const modulePath = path.join(directory, `pumpkin-${index}.mjs`);
        fs.writeFileSync(modulePath, generateEsmFacade(apiInterface, apiPackage.interfaces));
        await import(pathToFileURL(modulePath).href);
    }
    for (const [index, apiInterface] of wasiPackage.interfaces.entries()) {
        const modulePath = path.join(directory, `wasi-${index}.mjs`);
        fs.writeFileSync(modulePath, generateWasiEsmFacade(apiInterface));
        await import(pathToFileURL(modulePath).href);
    }

    const eventSource = allEventAccesses(apiPackage);
    const eventDispatch = generateWitEventDispatch(apiPackage, eventSource);
    const eventInterface = apiPackage.interfaces.find((apiInterface) => apiInterface.name === 'event');
    const eventVariant = eventInterface.variants.find((variant) => variant.name === 'event');
    const eventFieldCount = eventVariant.cases.reduce(
        (total, variant) =>
            total +
            apiPackage.interfaces
                .find((apiInterface) => apiInterface.name === 'event')
                .records.find((record) => record.name === variant.type).fields.length,
        0,
    );
    expect(count(eventDispatch, /case PUMPKIN_PLUGIN_EVENT_EVENT_TYPE_/g)).toBe(eventVariant.cases.length);
    expect(count(eventDispatch, /data\.setProperty\(runtime,/g)).toBeGreaterThanOrEqual(eventFieldCount);
    expect(eventDispatch).toContain('switch (event->tag)');

    const workspaceRoot = path.resolve(import.meta.dirname, '../../..');
    const toolchain = await setupHermesToolchainEnvironment({
        workspaceRoot,
        includeWasiSdk: false,
        includeWitBindgen: false,
        includeWasmTools: true,
    });
    const wasmTools = process.env.WASM_TOOLS ?? toolchain.WASM_TOOLS;
    const declarationOrder = readInterfaceDeclarationOrder(witDir);
    const document = readWitToolsDocument(witDir, { executable: wasmTools });
    const resolved = resolveWitDocument(document, declarationOrder);
    const importsInOrder = readPluginImportOrder(witDir);
    const typedApi = resolvePluginApi(resolved, importsInOrder);
    const typedWasi = resolveWasiImports(resolved, undefined, importsInOrder);
    const typedAnalysis = analyzeWitUsage(resolved, {
        pluginImportOrder: importsInOrder,
        wasiImports: typedWasi.imports,
        apiMethods,
    });
    const typedApiOperationCount = typedApi.interfaces.reduce(
        (total, apiInterface) =>
            total +
            apiInterface.functions.length +
            apiInterface.resources.reduce((resources, resource) => resources + resource.functions.length, 0),
        0,
    );
    expect(typedApi.interfaces).toHaveLength(apiPackage.interfaces.length);
    expect(typedApiOperationCount).toBe(apiMethods.length);
    expect(typedAnalysis.apiMethods).toEqual(apiMethods);
    expect(typedAnalysis.apiAdapters.map(({ operationId }) => operationId).sort()).toEqual([...apiMethods].sort());
    expect(typedWasi.interfaces).toHaveLength(wasiPackage.interfaces.length);
    expect([...typedAnalysis.wasiMethods].sort()).toEqual([...wasiMethods].sort());
    expect(typedAnalysis.wasiAdapters).toHaveLength(typedAnalysis.wasiMethods.length);
    expect(typedAnalysis.eventFields).toHaveLength(eventVariant.cases.length);

    const selectedAdapter = typedAnalysis.wasiAdapters.find(({ parameters }) => parameters.length > 0);
    expect(selectedAdapter).toBeDefined();
    const unresolvedSourceInterfaces = typedWasi.interfaces.map((apiInterface) => {
        const replaceSourceType = (operation, resource) => {
            const operationId = `${apiInterface.specifier}#${resource ? `${resource.name}.` : ''}${operation.name}`;
            return operationId === selectedAdapter.operationId
                ? {
                      ...operation,
                      parameters: operation.parameters.map((parameter) => ({
                          ...parameter,
                          type: 'unresolved-source-type',
                      })),
                  }
                : operation;
        };
        return {
            ...apiInterface,
            functions: apiInterface.functions.map((operation) => replaceSourceType(operation)),
            resources: apiInterface.resources.map((resource) => ({
                ...resource,
                functions: resource.functions.map((operation) => replaceSourceType(operation, resource)),
            })),
        };
    });
    expect(emitWasiAdapterDispatch(unresolvedSourceInterfaces, typedAnalysis)).toBe(
        withCurrentConventions(wasiDispatch),
    );

    const selectedApiOperation = typedApi.interfaces
        .flatMap((apiInterface) => [
            ...apiInterface.functions.map((operation) => ({ apiInterface, operation })),
            ...apiInterface.resources.flatMap((resource) =>
                resource.functions.map((operation) => ({ apiInterface, operation, resource })),
            ),
        ])
        .find(({ apiInterface, operation, resource }) => {
            const operationId = `${apiInterface.name}.${resource ? `${resource.name}.` : ''}${operation.name}`;
            return typedAnalysis.apiMethods.includes(operationId) && operation.parameters.length > 0;
        });
    expect(selectedApiOperation).toBeDefined();
    const unresolvedApiTypes = {
        ...typedApi,
        interfaces: typedApi.interfaces.map((apiInterface) => {
            const replaceSourceType = (operation, resource) => {
                const operationId = `${apiInterface.name}.${resource ? `${resource.name}.` : ''}${operation.name}`;
                return operationId ===
                    `${selectedApiOperation.apiInterface.name}.${selectedApiOperation.resource ? `${selectedApiOperation.resource.name}.` : ''}${selectedApiOperation.operation.name}`
                    ? {
                          ...operation,
                          parameters: operation.parameters.map((parameter) => ({
                              ...parameter,
                              type: 'unresolved-source-type',
                          })),
                      }
                    : operation;
            };
            return {
                ...apiInterface,
                functions: apiInterface.functions.map((operation) => replaceSourceType(operation)),
                resources: apiInterface.resources.map((resource) => ({
                    ...resource,
                    functions: resource.functions.map((operation) => replaceSourceType(operation, resource)),
                })),
            };
        }),
    };
    const typedPumpkinDispatch = emitPumpkinMethodDispatch(unresolvedApiTypes, typedAnalysis);
    // The frozen oracle drops only resources that an operation returns directly. Every declared
    // resource now has a drop branch, so compare the rest with the oracle.
    expect(withoutWitDrops(typedPumpkinDispatch)).toBe(withCurrentConventions(withoutWitDrops(pumpkinDispatch)));
    for (const apiInterface of typedApi.interfaces) {
        for (const resource of apiInterface.resources) {
            expect(typedPumpkinDispatch).toContain(
                `interfaceName == ${JSON.stringify(apiInterface.name)} && resourceName == ${JSON.stringify(resource.name)}) {`,
            );
        }
    }

    expect(typedApi.interfaces.map((apiInterface) => generateEsmFacade(apiInterface, typedApi.interfaces))).toEqual(
        apiPackage.interfaces.map((apiInterface) => generateEsmFacade(apiInterface, apiPackage.interfaces)),
    );
    expect(typedWasi.interfaces.map((apiInterface) => generateWasiEsmFacade(apiInterface))).toEqual(
        wasiPackage.interfaces.map((apiInterface) => generateWasiEsmFacade(apiInterface)),
    );
    const runtimeTemplate = fs.readFileSync(
        new URL('../src/component/templates/runtime-shim.template', import.meta.url),
        'utf8',
    );
    const apiEnumSpecs = [
        ['event', 'event-type', 'PUMPKIN_PLUGIN_EVENT_EVENT_TYPE_'],
        ['event', 'event-priority', 'PUMPKIN_PLUGIN_EVENT_EVENT_PRIORITY_'],
        ['game-rules', 'game-rule', 'PUMPKIN_PLUGIN_GAME_RULES_GAME_RULE_'],
        ['common', 'named-color', 'PUMPKIN_PLUGIN_COMMON_NAMED_COLOR_'],
    ];
    const pluginHeader = apiEnumSpecs
        .flatMap(([interfaceName, enumName, prefix]) => {
            const declaration = apiPackage.interfaces
                .find((apiInterface) => apiInterface.name === interfaceName)
                .enums.find((apiEnum) => apiEnum.name === enumName);
            return declaration.values.map((value) => `#define ${prefix}${value.toUpperCase().replaceAll('-', '_')} 0`);
        })
        .join('\n');
    const pluginHeaderPath = path.join(directory, 'plugin.h');
    const legacyApiEnumPath = path.join(directory, 'legacy-api-enums.generated.h');
    const eventUsagePath = path.join(directory, 'event-usage.js');
    fs.writeFileSync(pluginHeaderPath, pluginHeader);
    // Ask the frozen oracle for complete enum tables; current output retains them unconditionally.
    const priorities = apiPackage.interfaces
        .find(({ name }) => name === 'event')
        .enums.find(({ name }) => name === 'event-priority').values;
    fs.writeFileSync(eventUsagePath, `${eventSource}\n${priorities.map((value) => JSON.stringify(value)).join(';')}`);
    const typedOutput = generateWitOutputs({
        analysis: typedAnalysis,
        apiPackage: typedApi,
        wasiInterfaces: typedWasi.interfaces,
        pluginHeader,
        runtimeTemplate,
    });
    execFileSync(
        process.execPath,
        [
            path.join(runtimeRoot, 'test/oracles/generate-api-enums.mjs'),
            '--wit',
            witDir,
            '--bundle',
            eventUsagePath,
            '--header',
            pluginHeaderPath,
            '--output',
            legacyApiEnumPath,
        ],
        { stdio: 'pipe' },
    );
    expect(typedOutput.apiEnumHeader).toBe(fs.readFileSync(legacyApiEnumPath, 'utf8'));
    // Keep compatibility checks for unaffected adapter sections. Event conversion intentionally
    // diverges from the frozen oracle: callbacks receive and return complete payloads.
    const generatedFreeFunctions = readGeneratedFreeFunctions(fs.readFileSync(pluginHeaderPath, 'utf8'));
    expect(typedOutput.runtimeSource).toContain(
        emitWasiAdapterDispatch(wasiPackage.interfaces, typedAnalysis, generatedFreeFunctions),
    );
    expect(typedOutput.runtimeSource).toContain('installGeneratedWasiApiFunctions(*jsRuntime);');
    expect(typedOutput.runtimeSource).toContain(
        withCurrentConventions(withoutWitDrops(generateWitSimpleMethodDispatch(apiPackage, eventSource, apiMethods))),
    );
    expect(count(typedOutput.runtimeSource, /case PUMPKIN_PLUGIN_EVENT_EVENT_TYPE_/g)).toBe(eventVariant.cases.length);
    expect(count(typedOutput.runtimeSource, /data\.setProperty\(runtime,/g)).toBeGreaterThanOrEqual(eventFieldCount);
    expect(typedOutput.runtimeSource).not.toContain('<PUMPKIN_WIT_EVENT_');
}, 30_000);

function withoutWitDrops(dispatch) {
    const end = dispatch.indexOf('\n}\n');
    expect(dispatch.startsWith('void generatedWitDropResource(')).toBe(true);
    return dispatch.slice(end + 3);
}

/**
 * Applies the generator's intended changes to frozen oracle output. The oracle returns { tag: 'err' } for a
 * failed result<T>, where the generator throws through the error marker, and it tags resource states with a
 * ResourceKind, which the runtime no longer has.
 */
function withCurrentConventions(oracleDispatch) {
    return oracleDispatch
        .replaceAll(
            'errorValue.setProperty(rt, "tag", "err"); return errorValue;',
            'errorValue.setProperty(rt, "__staticHermesWitError", Value::null()); return errorValue;',
        )
        .replaceAll('ResourceState{ResourceKind::Wit, ', 'ResourceState{');
}

function count(source, expression) {
    return source.match(expression)?.length ?? 0;
}

/** Include every event tag and recursively referenced field in the generated event bundle source. */
function allEventAccesses(apiPackage) {
    const eventInterface = apiPackage.interfaces.find((apiInterface) => apiInterface.name === 'event');
    const event = eventInterface?.variants.find((variant) => variant.name === 'event');
    if (!eventInterface || !event) throw new Error('Pumpkin API WIT has no event variant');

    const records = new Map(
        apiPackage.interfaces.flatMap((apiInterface) => apiInterface.records.map((record) => [record.name, record])),
    );
    const aliases = new Map(
        apiPackage.interfaces.flatMap((apiInterface) => apiInterface.types.map((type) => [type.name, type.type])),
    );
    const source = [];

    for (const apiInterface of apiPackage.interfaces) {
        for (const record of apiInterface.records) {
            for (const field of record.fields) source.push(`data.${toJsName(field.name)};`);
        }
    }

    for (const variant of event.cases) {
        source.push(JSON.stringify(variant.name));
        const record = records.get(variant.type);
        if (!record) throw new Error(`Event ${variant.name} has no record ${variant.type}`);
        for (const field of record.fields) {
            const fieldPath = `data.${toJsName(field.name)}`;
            source.push(`${fieldPath};`);
            appendNestedRecordAccesses(field.type, fieldPath, records, aliases, source, new Set());
        }
    }

    return source.join('\n');
}

/** Include nested record fields so every field conversion path is selected. */
function appendNestedRecordAccesses(type, fieldPath, records, aliases, source, visited) {
    const name = [...type.matchAll(/[A-Za-z][\w-]*/g)]
        .map((match) => match[0])
        .find((candidate) => records.has(candidate) || aliases.has(candidate));
    if (!name || visited.has(name)) return;
    visited.add(name);

    const alias = aliases.get(name);
    if (alias !== undefined) {
        appendNestedRecordAccesses(alias, fieldPath, records, aliases, source, visited);
        return;
    }

    for (const field of records.get(name).fields) {
        const nestedPath = `${fieldPath}.${toJsName(field.name)}`;
        source.push(`${nestedPath};`);
        appendNestedRecordAccesses(field.type, nestedPath, records, aliases, source, visited);
    }
}

function toJsName(name) {
    return name.replace(/^%/, '').replace(/-([a-zA-Z0-9])/g, (_match, character) => character.toUpperCase());
}
