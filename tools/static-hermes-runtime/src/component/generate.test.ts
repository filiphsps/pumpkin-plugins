import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { generateWitOutputs } from '../wit/generation.ts';
import type { WitApiInterface, WitApiPackage } from '../wit/types.ts';
import type { ComponentWitAnalysis } from './analyze.ts';
import { generateComponentFiles } from './generate.ts';

const directories: string[] = [];

afterEach(() => {
    for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

it('runs wit-bindgen with selected features and writes generated runtime outputs', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'static-hermes-generate-'));
    directories.push(root);
    const templatePath = path.join(root, 'runtime.template.cpp');
    const outputDirectory = path.join(root, 'generated');
    fs.writeFileSync(
        templatePath,
        [
            '/* <PUMPKIN_WASI_RUNTIME> */',
            '/* <PUMPKIN_WASI_INITIALIZATION> */',
            '/* <PUMPKIN_WIT_SIMPLE_METHODS> */',
            '/* <PUMPKIN_WIT_EVENT_DISPATCH> */',
            '/* <PUMPKIN_WIT_EVENT_RESULT> */',
        ].join('\n'),
    );
    const calls: Array<{ command: string; args: string[] }> = [];

    const generated = generateComponentFiles({
        witDirectory: path.join(root, 'wit'),
        templatePath,
        outputDirectory,
        bindgenPath: '/toolchain/wit-bindgen',
        analysis: emptyAnalysis(['filesystem', 'sockets']),
        run(command, args) {
            calls.push({ command, args });
            const outputIndex = args.indexOf('--out-dir');
            const output = outputIndex < 0 ? undefined : args[outputIndex + 1];
            if (!output) throw new Error('wit-bindgen output directory is missing');
            fs.writeFileSync(path.join(output, 'plugin.c'), '/* generated C */');
            fs.writeFileSync(path.join(output, 'plugin.h'), '/* generated header */');
        },
    });

    expect(calls).toHaveLength(1);
    const bindgenArgs = calls[0]?.args ?? [];
    expect(calls[0]?.command).toBe('/toolchain/wit-bindgen');
    expect(bindgenArgs[bindgenArgs.indexOf('--features') + 1]).toBe('filesystem,sockets');
    expect(generated).toEqual({
        directory: path.join(outputDirectory, 'wit'),
        pluginC: path.join(outputDirectory, 'wit/plugin.c'),
        pluginHeader: path.join(outputDirectory, 'wit/plugin.h'),
        componentType: path.join(outputDirectory, 'wit/plugin_component_type.o'),
        runtimeSource: path.join(outputDirectory, 'runtime.cpp'),
    });
    expect(fs.readFileSync(generated.runtimeSource, 'utf8')).toContain('installGeneratedWasiApiFunctions(*jsRuntime);');
    expect(fs.readFileSync(generated.runtimeSource, 'utf8')).not.toContain('<PUMPKIN_');
    const apiEnumHeader = fs.readFileSync(path.join(outputDirectory, 'api-enums.generated.h'), 'utf8');
    expect(apiEnumHeader).toContain('// Generated from @pumpkin-plugins/pumpkin-api WIT');
    expect(apiEnumHeader).not.toContain('pumpkin-api-ts');
    expect(apiEnumHeader).toContain('namespace pumpkin_static_api');
});

it('omits the feature option when no WASI features are selected', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'static-hermes-generate-no-features-'));
    directories.push(root);
    const templatePath = path.join(root, 'runtime.template.cpp');
    fs.writeFileSync(
        templatePath,
        '/* <PUMPKIN_WASI_RUNTIME> */\n/* <PUMPKIN_WASI_INITIALIZATION> */\n/* <PUMPKIN_WIT_SIMPLE_METHODS> */\n/* <PUMPKIN_WIT_EVENT_DISPATCH> */\n/* <PUMPKIN_WIT_EVENT_RESULT> */',
    );
    const run = vi.fn((_command: string, args: string[]) => {
        const outputIndex = args.indexOf('--out-dir');
        const output = outputIndex < 0 ? undefined : args[outputIndex + 1];
        if (!output) throw new Error('wit-bindgen output directory is missing');
        fs.mkdirSync(output, { recursive: true });
        fs.writeFileSync(path.join(output, 'plugin.c'), '');
        fs.writeFileSync(path.join(output, 'plugin.h'), '');
    });

    generateComponentFiles({
        witDirectory: path.join(root, 'wit'),
        templatePath,
        outputDirectory: path.join(root, 'generated'),
        bindgenPath: '/toolchain/wit-bindgen',
        analysis: emptyAnalysis([]),
        run,
    });

    expect(run.mock.calls[0]?.[1]).not.toContain('--features');
});

it('does not write runtime outputs if wit-bindgen fails', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'static-hermes-generate-failure-'));
    directories.push(root);
    const templatePath = path.join(root, 'runtime.template.cpp');
    const outputDirectory = path.join(root, 'generated');
    fs.writeFileSync(templatePath, '');

    expect(() =>
        generateComponentFiles({
            witDirectory: path.join(root, 'wit'),
            templatePath,
            outputDirectory,
            bindgenPath: '/toolchain/wit-bindgen',
            analysis: emptyAnalysis([]),
            run() {
                throw new Error('wit-bindgen failed');
            },
        }),
    ).toThrow('wit-bindgen failed');
    expect(fs.existsSync(path.join(outputDirectory, 'runtime.cpp'))).toBe(false);
});

function emptyAnalysis(wasiFeatures: string[]): ComponentWitAnalysis {
    const apiPackage: WitApiPackage = {
        packageName: 'pumpkin:plugin',
        version: '0.1.0',
        interfaces: [
            apiInterface('event', [
                { name: 'event-type', values: [] },
                { name: 'event-priority', values: [] },
            ]),
            apiInterface('game-rules', [{ name: 'game-rule', values: [] }]),
            apiInterface('common', [{ name: 'named-color', values: [] }]),
        ],
    };
    return {
        apiPackage,
        analysis: {
            apiInterfaces: [],
            apiMethods: [],
            apiAdapters: [],
            wasiImports: [],
            wasiInterfaces: [],
            resolvedWasiInterfaces: [],
            wasiMethods: [],
            wasiFeatures,
            wasiAdapters: [],
            eventFields: [],
        },
    };
}

function apiInterface(name: string, enums: WitApiInterface['enums']): WitApiInterface {
    return {
        name,
        specifier: `pumpkin:plugin/${name}@0.1.0`,
        functions: [],
        resources: [],
        records: [],
        variants: [],
        enums,
        flags: [],
        types: [],
    };
}

it('keeps enum lookup entries for computed event tags and priorities', () => {
    const input = emptyAnalysis([]);
    const eventInterface = input.apiPackage.interfaces[0];
    if (!eventInterface) throw new Error('event fixture is missing');
    eventInterface.enums = [
        { name: 'event-type', values: ['join'] },
        { name: 'event-priority', values: ['normal'] },
    ];
    const output = generateWitOutputs({
        ...input,
        wasiInterfaces: [],
        pluginHeader:
            '#define PUMPKIN_PLUGIN_EVENT_EVENT_TYPE_JOIN 7\n#define PUMPKIN_PLUGIN_EVENT_EVENT_PRIORITY_NORMAL 3',
        runtimeTemplate: [
            '/* <PUMPKIN_WASI_RUNTIME> */',
            '/* <PUMPKIN_WASI_INITIALIZATION> */',
            '/* <PUMPKIN_WIT_SIMPLE_METHODS> */',
            '/* <PUMPKIN_WIT_EVENT_DISPATCH> */',
            '/* <PUMPKIN_WIT_EVENT_RESULT> */',
        ].join('\n'),
    });
    const lookup = new Map(
        [...output.apiEnumHeader.matchAll(/\{"([^"}]+)", ([A-Z_]+)\}/g)].map(([, name, constant]) => [name, constant]),
    );
    expect(lookup.get('join')).toBe('PUMPKIN_PLUGIN_EVENT_EVENT_TYPE_JOIN');
    expect(lookup.get('normal')).toBe('PUMPKIN_PLUGIN_EVENT_EVENT_PRIORITY_NORMAL');
});
