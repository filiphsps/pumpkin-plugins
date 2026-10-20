import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { compileAndLinkComponent } from './compile.ts';
import type { ComponentGeneratedFiles } from './generate.ts';
import type { ComponentBuildOptions } from './types.ts';

const directories: string[] = [];

afterEach(() => {
    for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

it.each([
    { name: 'JavaScript bundle', parseTypeScript: false },
    { name: 'TypeScript bundle', parseTypeScript: true },
])('compiles a $name with the selected optimization profile', ({ parseTypeScript }) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'static-hermes-component-compile-'));
    directories.push(root);
    const temporaryDirectory = path.join(root, 'temporary');
    const generatedDirectory = path.join(temporaryDirectory, 'wit');
    fs.mkdirSync(generatedDirectory, { recursive: true });
    const bundle = path.join(root, parseTypeScript ? 'bundle.ts' : 'bundle.js');
    const output = path.join(root, 'plugin.wasm');
    const bundleBytes = Buffer.from(
        parseTypeScript ? 'const pluginName: string = "compile-test";\r\n' : 'registerPlugin({});\r\n',
    );
    fs.writeFileSync(bundle, bundleBytes);
    const generated: ComponentGeneratedFiles = {
        directory: generatedDirectory,
        pluginC: path.join(generatedDirectory, 'plugin.c'),
        pluginHeader: path.join(generatedDirectory, 'plugin.h'),
        componentType: path.join(generatedDirectory, 'plugin_component_type.o'),
        runtimeSource: path.join(temporaryDirectory, 'runtime.cpp'),
    };
    const options: ComponentBuildOptions = {
        bundle,
        wit: path.join(root, 'wit'),
        output,
        developmentMode: false,
        wasiImports: [],
        runtimeVariant: 'full',
        ...(parseTypeScript ? { parseTypeScript: true } : {}),
    };
    const calls: Array<{ command: string; args: string[] }> = [];

    compileAndLinkComponent({
        options,
        generated,
        temporaryDirectory,
        stackSizeBytes: '262144',
        toolchain: {
            hermesSource: path.join(root, 'hermes-source'),
            hermesWasiBuild: path.join(root, 'hermes-wasi'),
            hermesRuntimeArchive: path.join(root, 'hermes-wasi/lib/libhermesvm_a.a'),
            hermesc: path.join(root, 'hermes-host/bin/hermesc'),
            wasiSdk: path.join(root, 'wasi-sdk'),
        },
        run(command, args) {
            calls.push({ command, args });
            const embeddedOutput = args.find((argument) => argument.startsWith('-out='));
            if (embeddedOutput) fs.writeFileSync(embeddedOutput.slice('-out='.length), Buffer.from([0, 1, 2]));
            const outputIndex = args.indexOf('-o');
            const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
            if (outputPath) fs.writeFileSync(outputPath, 'compiled');
        },
    });

    expect(calls.map(({ command }) => path.basename(command))).toEqual([
        'hermesc',
        'wasm32-wasip2-clang',
        'wasm32-wasip2-clang++',
        'wasm32-wasip2-clang++',
    ]);
    expect(calls[0]?.args).toContain('-O4');
    expect(calls[0]?.args.includes('-parse-ts')).toBe(parseTypeScript);
    expect(calls[0]?.args).toContain('-fstrip-function-names');
    expect(calls[1]?.args).toContain('-wasm-enable-sjlj');
    expect(calls[2]?.args).toContain('-fwasm-exceptions');
    expect(calls[3]?.args).toContain('-Wl,--strip-all');
    expect(calls[3]?.args).toContain('-Wl,-z,stack-size=262144');
    expect(fs.existsSync(output)).toBe(true);
    const compiledBundlePath = calls[0]?.args.at(-1) ?? '';
    expect(compiledBundlePath).not.toBe(bundle);
    expect(path.dirname(compiledBundlePath)).toBe(temporaryDirectory);
    expect(fs.readFileSync(compiledBundlePath, 'utf8')).toContain(
        parseTypeScript ? 'pluginName: string' : '__pumpkinPluginInitError',
    );
    expect(fs.readFileSync(bundle)).toEqual(bundleBytes);
    expect(fs.readFileSync(path.join(temporaryDirectory, 'plugin-bytecode.generated.h'), 'utf8')).toContain(
        '#embed "plugin_bundle.hbc"',
    );
    expect(fs.readFileSync(path.join(temporaryDirectory, 'plugin_bundle.hbc'))).toEqual(Buffer.from([0, 1, 2]));
});
