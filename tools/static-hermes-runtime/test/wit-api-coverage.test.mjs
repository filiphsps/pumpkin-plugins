import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { CAPABILITIES, wasiInterfaces } from '../../build/src/capabilities.ts';
import { cacheDir } from '../../build/src/repo.ts';
import { ensureWasiWit, readLock } from '../../build/src/wasi-wit.ts';
import { prepareWit } from '../../build/src/wit.ts';
import {
    generateEsmFacade,
    generateWasiAdapterDispatch,
    generateWasiEsmFacade,
    generateWitEventDispatch,
    generateWitSimpleMethodDispatch,
    planWasiAdapterDispatch,
    readWasiWitImports,
    readWitPackage
} from '../bin/wit-api.mjs';

const directories = [];
const apiWitDir = path.join(
    path.dirname(createRequire(import.meta.url).resolve('@pumpkinmc/pumpkin-api-ts/package.json')),
    'wit/v0.1'
);

afterEach(() => {
    for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

it('generates facades and native adapters for the full pinned Pumpkin and WASI WIT surface', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'static-hermes-wit-coverage-'));
    directories.push(directory);

    const lock = readLock();
    const wasiWit = await ensureWasiWit({ cacheDir: cacheDir(import.meta.dirname), lock });
    const imports = wasiInterfaces(Object.keys(CAPABILITIES));
    const witDir = prepareWit({
        apiWit: apiWitDir,
        target: path.join(directory, 'wit'),
        interfaces: imports,
        wasiWit,
        wasiFiles: Object.keys(lock.files)
    });
    const apiPackage = readWitPackage(witDir);
    const wasiPackage = readWasiWitImports(witDir);

    const apiMethods = apiPackage.interfaces.flatMap((apiInterface) => [
        ...apiInterface.functions.map((operation) => `${apiInterface.name}.${operation.name}`),
        ...apiInterface.resources.flatMap((resource) =>
            resource.functions.map((operation) => `${apiInterface.name}.${resource.name}.${operation.name}`)
        )
    ]);
    const wasiMethods = wasiPackage.interfaces.flatMap((apiInterface) => [
        ...apiInterface.functions.map((operation) => `${apiInterface.specifier}#${operation.name}`),
        ...apiInterface.resources.flatMap((resource) =>
            resource.functions.map((operation) => `${apiInterface.specifier}#${resource.name}.${operation.name}`)
        )
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
        0
    );
    expect(count(eventDispatch, /case PUMPKIN_PLUGIN_EVENT_EVENT_TYPE_/g)).toBe(eventVariant.cases.length);
    expect(count(eventDispatch, /data\.setProperty\(runtime,/g)).toBeGreaterThanOrEqual(eventFieldCount);
    expect(eventDispatch).toContain('switch (event->tag)');
}, 30_000);

function count(source, expression) {
    return source.match(expression)?.length ?? 0;
}

/** Include every event tag and recursively referenced field in the generated event bundle source. */
function allEventAccesses(apiPackage) {
    const eventInterface = apiPackage.interfaces.find((apiInterface) => apiInterface.name === 'event');
    const event = eventInterface?.variants.find((variant) => variant.name === 'event');
    if (!eventInterface || !event) throw new Error('Pumpkin API WIT has no event variant');

    const records = new Map(
        apiPackage.interfaces.flatMap((apiInterface) => apiInterface.records.map((record) => [record.name, record]))
    );
    const aliases = new Map(
        apiPackage.interfaces.flatMap((apiInterface) => apiInterface.types.map((type) => [type.name, type.type]))
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
