import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { compileAndLinkComponent } from '../src/component/compile.ts';
import type { ComponentGeneratedFiles } from '../src/component/generate.ts';
import type { ComponentBuildOptions } from '../src/component/types.ts';

const directories: string[] = [];

afterEach(() => {
    for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

it('compiles bytecode and links the generated component with the selected optimization profile', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'static-hermes-component-compile-'));
    directories.push(root);
    const temporaryDirectory = path.join(root, 'temporary');
    const generatedDirectory = path.join(temporaryDirectory, 'wit');
    fs.mkdirSync(generatedDirectory, { recursive: true });
    const bundle = path.join(root, 'bundle.js');
    const output = path.join(root, 'plugin.wasm');
    fs.writeFileSync(bundle, 'registerPlugin({});');
    const generated: ComponentGeneratedFiles = {
        directory: generatedDirectory,
        pluginC: path.join(generatedDirectory, 'plugin.c'),
        pluginHeader: path.join(generatedDirectory, 'plugin.h'),
        componentType: path.join(generatedDirectory, 'plugin_component_type.o'),
        runtimeSource: path.join(temporaryDirectory, 'runtime.cpp')
    };
    const options: ComponentBuildOptions = {
        bundle,
        wit: path.join(root, 'wit'),
        output,
        developmentMode: false,
        wasiImports: [],
        runtimeVariant: 'full'
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
            wasiSdk: path.join(root, 'wasi-sdk')
        },
        run(command, args) {
            calls.push({ command, args });
            const embeddedOutput = args.find((argument) => argument.startsWith('-out='));
            if (embeddedOutput) fs.writeFileSync(embeddedOutput.slice('-out='.length), Buffer.from([0, 1, 2]));
            const outputIndex = args.indexOf('-o');
            const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
            if (outputPath) fs.writeFileSync(outputPath, 'compiled');
        }
    });

    expect(calls.map(({ command }) => path.basename(command))).toEqual([
        'hermesc',
        'wasm32-wasip2-clang',
        'wasm32-wasip2-clang++',
        'wasm32-wasip2-clang++'
    ]);
    expect(calls[0]?.args).toContain('-O4');
    expect(calls[0]?.args).toContain('-fstrip-function-names');
    expect(calls[1]?.args).toContain('-wasm-enable-sjlj');
    expect(calls[2]?.args).toContain('-fwasm-exceptions');
    expect(calls[3]?.args).toContain('-Wl,--strip-all');
    expect(calls[3]?.args).toContain('-Wl,-z,stack-size=262144');
    expect(fs.existsSync(output)).toBe(true);
    expect(fs.readFileSync(path.join(temporaryDirectory, 'plugin-bytecode.generated.h'), 'utf8')).toContain(
        '0x00, 0x01, 0x02'
    );
    expect(fs.readFileSync(bundle, 'utf8')).toContain('__pumpkinPluginInitError');
});
