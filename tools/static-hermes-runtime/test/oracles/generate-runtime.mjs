#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseJsonStringArray } from './cli-arguments.mjs';
import {
    generateWasiAdapterDispatch,
    generateWitEventDispatch,
    generateWitSimpleMethodDispatch,
    readWasiWitImports,
    readWitPackage
} from './wit-api.mjs';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
    const key = process.argv[index];
    const value = process.argv[index + 1];
    if (!key?.startsWith('--') || !value || args.has(key.slice(2))) {
        throw new Error(`Invalid argument near ${key ?? '(end)'}`);
    }
    args.set(key.slice(2), value);
}

const witDir = requiredPath('wit');
const bundlePath = requiredPath('bundle');
const templatePath = requiredPath('template');
const outputPath = requiredPath('output');
const imports = parseJsonStringArray(required('wasi-imports'), 'wasi-imports', 'module specifiers');
const wasiMethods = parseJsonStringArray(args.get('wasi-methods'), 'wasi-methods', 'WASI method identifiers');
const usedMethodImports = (wasiMethods ?? []).flatMap((operationId) => {
    const separator = operationId.indexOf('#');
    return separator > 0 ? [operationId.slice(0, separator)] : [];
});
const adapterImports = [...new Set([...imports, ...usedMethodImports])];
const apiMethods = parseJsonStringArray(args.get('api-methods'), 'api-methods', 'method identifiers');
const bundleSource = fs.readFileSync(bundlePath, 'utf8');
const sourceTemplate = fs.readFileSync(templatePath, 'utf8');
const apiPackage = readWitPackage(witDir);
const wasiWit = readWasiWitImports(witDir, adapterImports);

const wasiRuntime = generateWasiAdapterDispatch(wasiWit.interfaces, wasiWit.interfaces, wasiMethods);
const wasiInitialization = 'installGeneratedWasiApiFunctions(*jsRuntime);';

let generatedSource = sourceTemplate;
generatedSource = replaceMarker(generatedSource, '/* <PUMPKIN_WASI_RUNTIME> */', wasiRuntime);
generatedSource = replaceMarker(generatedSource, '/* <PUMPKIN_WASI_INITIALIZATION> */', wasiInitialization);
generatedSource = replaceMarker(
    generatedSource,
    '/* <PUMPKIN_WIT_SIMPLE_METHODS> */',
    generateWitSimpleMethodDispatch(apiPackage, bundleSource, apiMethods)
);
generatedSource = replaceMarker(
    generatedSource,
    '/* <PUMPKIN_WIT_EVENT_DISPATCH> */',
    generateWitEventDispatch(apiPackage, bundleSource)
);
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
const temporaryPath = `${outputPath}.${process.pid}.tmp`;
try {
    fs.writeFileSync(temporaryPath, generatedSource);
    fs.renameSync(temporaryPath, outputPath);
} finally {
    fs.rmSync(temporaryPath, { force: true });
}

/** Read a required command-line argument. */
function required(name) {
    const value = args.get(name);
    if (!value) throw new Error(`Missing --${name}`);
    return value;
}

/** Resolve a required command-line path against the current directory. */
function requiredPath(name) {
    return path.resolve(required(name));
}

/** Replace the one required template marker with generated source. */
function replaceMarker(source, marker, replacement) {
    if (source.split(marker).length !== 2) {
        throw new Error(`runtime template must contain exactly one ${marker} marker`);
    }
    return source.replace(marker, replacement);
}
