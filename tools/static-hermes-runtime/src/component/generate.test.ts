import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
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
    const bundlePath = path.join(root, 'bundle.js');
    const templatePath = path.join(root, 'runtime.template.cpp');
    const outputDirectory = path.join(root, 'generated');
    fs.writeFileSync(bundlePath, 'registerPlugin({});');
    fs.writeFileSync(
        templatePath,
        [
            '/* <PUMPKIN_WASI_RUNTIME> */',
            '/* <PUMPKIN_WASI_INITIALIZATION> */',
            '/* <PUMPKIN_WIT_SIMPLE_METHODS> */',
            '/* <PUMPKIN_WIT_EVENT_DISPATCH> */'
        ].join('\n')
    );
    const calls: Array<{ command: string; args: string[] }> = [];

    const generated = generateComponentFiles({
        witDirectory: path.join(root, 'wit'),
        bundlePath,
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
        }
    });

    expect(calls).toEqual([
        {
            command: '/toolchain/wit-bindgen',
            args: [
                'c',
                path.join(root, 'wit'),
                '--world',
                'plugin',
                '--features',
                'filesystem,sockets',
                '--out-dir',
                path.join(outputDirectory, 'wit')
            ]
        }
    ]);
    expect(generated).toEqual({
        directory: path.join(outputDirectory, 'wit'),
        pluginC: path.join(outputDirectory, 'wit/plugin.c'),
        pluginHeader: path.join(outputDirectory, 'wit/plugin.h'),
        componentType: path.join(outputDirectory, 'wit/plugin_component_type.o'),
        runtimeSource: path.join(outputDirectory, 'runtime.cpp')
    });
    expect(fs.readFileSync(generated.runtimeSource, 'utf8')).toContain('installGeneratedWasiApiFunctions(*jsRuntime);');
    expect(fs.readFileSync(generated.runtimeSource, 'utf8')).not.toContain('<PUMPKIN_');
    expect(fs.readFileSync(path.join(outputDirectory, 'api-enums.generated.h'), 'utf8')).toContain(
        'namespace pumpkin_static_api'
    );
});

it('omits the feature option when no WASI features are selected', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'static-hermes-generate-no-features-'));
    directories.push(root);
    const bundlePath = path.join(root, 'bundle.js');
    const templatePath = path.join(root, 'runtime.template.cpp');
    fs.writeFileSync(bundlePath, 'registerPlugin({});');
    fs.writeFileSync(
        templatePath,
        '/* <PUMPKIN_WASI_RUNTIME> */\n/* <PUMPKIN_WASI_INITIALIZATION> */\n/* <PUMPKIN_WIT_SIMPLE_METHODS> */\n/* <PUMPKIN_WIT_EVENT_DISPATCH> */'
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
        bundlePath,
        templatePath,
        outputDirectory: path.join(root, 'generated'),
        bindgenPath: '/toolchain/wit-bindgen',
        analysis: emptyAnalysis([]),
        run
    });

    expect(run.mock.calls[0]?.[1]).not.toContain('--features');
});

it('does not write runtime outputs if wit-bindgen fails', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'static-hermes-generate-failure-'));
    directories.push(root);
    const bundlePath = path.join(root, 'bundle.js');
    const templatePath = path.join(root, 'runtime.template.cpp');
    const outputDirectory = path.join(root, 'generated');
    fs.writeFileSync(bundlePath, '');
    fs.writeFileSync(templatePath, '');

    expect(() =>
        generateComponentFiles({
            witDirectory: path.join(root, 'wit'),
            bundlePath,
            templatePath,
            outputDirectory,
            bindgenPath: '/toolchain/wit-bindgen',
            analysis: emptyAnalysis([]),
            run() {
                throw new Error('wit-bindgen failed');
            }
        })
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
                { name: 'event-priority', values: [] }
            ]),
            apiInterface('game-rules', [{ name: 'game-rule', values: [] }]),
            apiInterface('common', [{ name: 'named-color', values: [] }])
        ]
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
            eventFields: []
        }
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
        types: []
    };
}
