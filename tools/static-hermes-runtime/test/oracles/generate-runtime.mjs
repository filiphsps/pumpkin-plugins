#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Command, InvalidArgumentError, Option } from 'commander';
import { parseJsonStringArray } from './cli-arguments.mjs';
import {
    generateWasiAdapterDispatch,
    generateWitEventDispatch,
    generateWitSimpleMethodDispatch,
    readWasiWitImports,
    readWitPackage,
} from './wit-api.mjs';

const program = new Command()
    .name('generate-runtime')
    .description('Generate Static Hermes runtime dispatch code from WIT and bundle metadata.')
    .addOption(requiredOption('wit', 'WIT directory'))
    .addOption(requiredOption('bundle', 'Bundled plugin JavaScript'))
    .addOption(requiredOption('template', 'Runtime source template'))
    .addOption(requiredOption('wasi-imports', 'JSON array of selected WASI interfaces'))
    .addOption(optionalOption('wasi-methods', 'JSON array of selected WASI operations'))
    .addOption(optionalOption('api-methods', 'JSON array of selected Pumpkin API operations'))
    .addOption(requiredOption('output', 'Generated runtime source destination'))
    .parse(process.argv);
const options = program.opts();

const witDir = path.resolve(options.wit);
const bundlePath = path.resolve(options.bundle);
const templatePath = path.resolve(options.template);
const outputPath = path.resolve(options.output);
const imports = parseJsonStringArray(options.wasiImports, 'wasi-imports', 'module specifiers');
const wasiMethods = parseJsonStringArray(options.wasiMethods, 'wasi-methods', 'WASI method identifiers');
const usedMethodImports = (wasiMethods ?? []).flatMap((operationId) => {
    const separator = operationId.indexOf('#');
    return separator > 0 ? [operationId.slice(0, separator)] : [];
});
const adapterImports = [...new Set([...imports, ...usedMethodImports])];
const apiMethods = parseJsonStringArray(options.apiMethods, 'api-methods', 'method identifiers');
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
    generateWitSimpleMethodDispatch(apiPackage, bundleSource, apiMethods),
);
generatedSource = replaceMarker(
    generatedSource,
    '/* <PUMPKIN_WIT_EVENT_DISPATCH> */',
    generateWitEventDispatch(apiPackage, bundleSource),
);
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
const temporaryPath = `${outputPath}.${process.pid}.tmp`;
try {
    fs.writeFileSync(temporaryPath, generatedSource);
    fs.renameSync(temporaryPath, outputPath);
} finally {
    fs.rmSync(temporaryPath, { force: true });
}

/** Create a Commander option that must be supplied. */
function requiredOption(name, description) {
    return option(name, description).makeOptionMandatory();
}

/** Create an optional Commander option. */
function optionalOption(name, description) {
    return option(name, description);
}

/** Create a Commander option that preserves the CLI's duplicate-value rejection. */
function option(name, description) {
    return new Option(`--${name} <value>`, description).argParser((value, previous) => {
        if (previous !== undefined) throw new InvalidArgumentError(`Option --${name} may only be provided once`);
        return value;
    });
}

/** Replace the one required template marker with generated source. */
function replaceMarker(source, marker, replacement) {
    if (source.split(marker).length !== 2) {
        throw new Error(`runtime template must contain exactly one ${marker} marker`);
    }
    return source.replace(marker, replacement);
}
