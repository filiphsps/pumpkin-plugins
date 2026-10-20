import * as fs from 'node:fs';
import * as path from 'node:path';
import type { WitAnalysis } from './analysis.ts';
import { generateWitEventDispatch, generateWitEventResultDispatch } from './event-dispatch.ts';
import { generatePumpkinMethodDispatch } from './pumpkin-dispatch.ts';
import type { WitApiPackage, WitWasiInterface } from './types.ts';
import { generateWasiAdapterDispatch } from './wasi-dispatch.ts';

/** Resolved WIT analysis and source fragments used to generate component runtime files. */
export interface WitGenerationInput {
    /** Selected API/WASI operations, features, adapters, and event payload fields. */
    analysis: WitAnalysis;
    /** Resolved Pumpkin package used to emit API dispatch and enum constants. */
    apiPackage: WitApiPackage;
    /** Generated `plugin.h` used to validate native enum constants. */
    pluginHeader: string;
    /** Runtime C++ template containing the generator marker comments. */
    runtimeTemplate: string;
    /** Resolved WASI interfaces to pass to native adapter generation. */
    wasiInterfaces: readonly WitWasiInterface[];
}

/** Generated runtime source and API enum header ready for component compilation. */
export interface WitGenerationOutput {
    /** C header defining the API enum constants used by the generated bindings. */
    apiEnumHeader: string;
    /** Runtime C++ source with generated dispatch and WASI adapters inserted. */
    runtimeSource: string;
}

/**
 * Generate deterministic runtime and API enum outputs from one resolved analysis plan.
 *
 * @param input - WIT analysis, resolved interfaces, and generated source fragments.
 * @returns C++ runtime source and the generated API enum header.
 * @throws {Error} If required template markers, WIT enums, or native enum constants are missing.
 */
export function generateWitOutputs(input: WitGenerationInput): WitGenerationOutput {
    const availableFreeFunctions = readGeneratedFreeFunctions(input.pluginHeader);
    const wasiRuntime = generateWasiAdapterDispatch(input.wasiInterfaces, input.analysis, availableFreeFunctions);
    let runtimeSource = input.runtimeTemplate;
    runtimeSource = replaceMarker(runtimeSource, '/* <PUMPKIN_WASI_RUNTIME> */', wasiRuntime);
    runtimeSource = replaceMarker(
        runtimeSource,
        '/* <PUMPKIN_WASI_INITIALIZATION> */',
        'installGeneratedWasiApiFunctions(*jsRuntime);',
    );
    runtimeSource = replaceMarker(
        runtimeSource,
        '/* <PUMPKIN_WIT_SIMPLE_METHODS> */',
        generatePumpkinMethodDispatch(input.apiPackage, input.analysis),
    );
    runtimeSource = replaceMarker(
        runtimeSource,
        '/* <PUMPKIN_WIT_EVENT_DISPATCH> */',
        generateWitEventDispatch(input.apiPackage, input.analysis.eventFields),
    );
    runtimeSource = replaceMarker(
        runtimeSource,
        '/* <PUMPKIN_WIT_EVENT_RESULT> */',
        generateWitEventResultDispatch(input.apiPackage, input.analysis.eventFields),
    );
    return {
        runtimeSource,
        apiEnumHeader: generateApiEnumHeader(input.apiPackage, input.pluginHeader),
    };
}

/**
 * Read the standalone cleanup functions declared by wit-bindgen in a generated C header.
 *
 * @param pluginHeader - Generated C header containing wit-bindgen declarations.
 * @returns The names of declared cleanup functions.
 */
export function readGeneratedFreeFunctions(pluginHeader: string): ReadonlySet<string> {
    return new Set([...pluginHeader.matchAll(/^\s*void\s+([A-Za-z_]\w*_free)\s*\(/gm)].map(([, name]) => name));
}

/**
 * Write generated code through adjacent temporary files so interrupted writes do not truncate output.
 *
 * @param outputDirectory - Directory that receives `runtime.cpp` and `api-enums.generated.h`.
 * @param output - Generated C++ source and enum header contents.
 */
export function writeWitGeneration(outputDirectory: string, output: WitGenerationOutput): void {
    fs.mkdirSync(outputDirectory, { recursive: true });
    writeAtomically(path.join(outputDirectory, 'runtime.cpp'), output.runtimeSource);
    writeAtomically(path.join(outputDirectory, 'api-enums.generated.h'), output.apiEnumHeader);
}

function generateApiEnumHeader(apiPackage: WitApiPackage, pluginHeader: string): string {
    const enumSpecs = [
        ['eventTypes', 'event', 'event-type', 'PUMPKIN_PLUGIN_EVENT_EVENT_TYPE_'],
        ['eventPriorities', 'event', 'event-priority', 'PUMPKIN_PLUGIN_EVENT_EVENT_PRIORITY_'],
        ['gameRules', 'game-rules', 'game-rule', 'PUMPKIN_PLUGIN_GAME_RULES_GAME_RULE_'],
        ['namedColors', 'common', 'named-color', 'PUMPKIN_PLUGIN_COMMON_NAMED_COLOR_'],
    ] as const;
    const entries = enumSpecs.map(([name, interfaceName, enumName, prefix]) => {
        const apiInterface = apiPackage.interfaces.find((candidate) => candidate.name === interfaceName);
        const declaration = apiInterface?.enums.find(({ name: candidate }) => candidate === enumName);
        if (!declaration) throw new Error(`WIT enum ${enumName} not found in interface ${interfaceName}`);
        const values = declaration.values.map((variant) => {
            const cName = `${prefix}${variant.toUpperCase().replaceAll('-', '_')}`;
            if (!new RegExp(`^#define ${cName} \\d+$`, 'm').test(pluginHeader)) {
                throw new Error(`Generated Pumpkin C bindings are missing ${cName}`);
            }
            return { variant, cName };
        });
        return { name, values };
    });
    return `// Generated from @pumpkin-plugins/pumpkin-api WIT and wit-bindgen C bindings. Do not edit.
#pragma once
#include <array>
#include <cstdint>
#include <string_view>
#include "plugin.h"

namespace pumpkin_static_api {
struct EnumEntry {
  std::string_view name;
  uint32_t value;
};
${entries
    .map(
        ({ name, values }) => `inline constexpr std::array<EnumEntry, ${values.length}> ${name}{{
${values.map(({ variant, cName }) => `  {"${variant}", ${cName}},`).join('\n')}
}};`,
    )
    .join('\n\n')}
} // namespace pumpkin_static_api
`;
}

function replaceMarker(source: string, marker: string, replacement: string): string {
    if (source.split(marker).length !== 2)
        throw new Error(`runtime template must contain exactly one ${marker} marker`);
    return source.replace(marker, replacement);
}

function writeAtomically(filename: string, contents: string): void {
    const temporary = `${filename}.${process.pid}.tmp`;
    try {
        fs.writeFileSync(temporary, contents);
        fs.renameSync(temporary, filename);
    } finally {
        fs.rmSync(temporary, { force: true });
    }
}
