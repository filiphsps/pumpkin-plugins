import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { generateWitOutputs, writeWitGeneration } from '../wit/generation.ts';
import type { ComponentWitAnalysis } from './analyze.ts';

/** Paths to generated WIT bindings and the component runtime source. */
export interface ComponentGeneratedFiles {
    /** Compiled component type object produced by wit-bindgen. */
    componentType: string;
    /** Directory containing the generated C bindings and component type object. */
    directory: string;
    /** Generated C implementation for the plugin's WIT world. */
    pluginC: string;
    /** Generated header included by the native bindings. */
    pluginHeader: string;
    /** Generated C++ runtime shim source. */
    runtimeSource: string;
}

/** Inputs for generating per-plugin native bindings from resolved WIT analysis. */
export interface ComponentGenerationInput {
    /** Resolved API and WASI analysis used to generate native adapters. */
    analysis: ComponentWitAnalysis;
    /** Path to the pinned wit-bindgen executable. */
    bindgenPath: string;
    /** Temporary output directory for generated bindings and runtime source. */
    outputDirectory: string;
    /** Optional command runner, primarily for tests that inspect tool invocations. */
    run?: (command: string, args: string[]) => void;
    /** C++ runtime template populated with generated adapters and dispatch. */
    templatePath: string;
    /** Prepared WIT directory passed to wit-bindgen. */
    witDirectory: string;
}

/**
 * Run wit-bindgen and emit per-plugin native adapters from the typed WIT analysis.
 *
 * @param input - WIT inputs, analysis results, output paths, and optional command runner.
 * @returns Paths to the generated files consumed by the component compiler.
 */
export function generateComponentFiles(input: ComponentGenerationInput): ComponentGeneratedFiles {
    const generatedDirectory = path.join(input.outputDirectory, 'wit');
    const pluginC = path.join(generatedDirectory, 'plugin.c');
    const pluginHeader = path.join(generatedDirectory, 'plugin.h');
    const componentType = path.join(generatedDirectory, 'plugin_component_type.o');
    const runtimeSource = path.join(input.outputDirectory, 'runtime.cpp');
    fs.mkdirSync(generatedDirectory, { recursive: true });
    const run = input.run ?? ((command, args) => execFileSync(command, args, { stdio: 'inherit' }));
    run(input.bindgenPath, [
        'c',
        input.witDirectory,
        '--world',
        'plugin',
        ...(input.analysis.analysis.wasiFeatures.length === 0
            ? []
            : ['--features', input.analysis.analysis.wasiFeatures.join(',')]),
        '--out-dir',
        generatedDirectory,
    ]);

    const generated = generateWitOutputs({
        analysis: input.analysis.analysis,
        apiPackage: input.analysis.apiPackage,
        wasiInterfaces: input.analysis.analysis.resolvedWasiInterfaces,
        pluginHeader: fs.readFileSync(pluginHeader, 'utf8'),
        runtimeTemplate: fs.readFileSync(input.templatePath, 'utf8'),
    });
    writeWitGeneration(input.outputDirectory, generated);
    return { directory: generatedDirectory, pluginC, pluginHeader, componentType, runtimeSource };
}
