#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Command } from 'commander';

const program = new Command()
    .name('generate-api-enums')
    .description('Generate the Pumpkin API enum lookup header from WIT and C bindings.')
    .requiredOption('--wit <directory>', 'Directory containing the Pumpkin WIT files')
    .requiredOption('--bundle <file>', 'Bundled plugin JavaScript')
    .requiredOption('--header <file>', 'Generated Pumpkin plugin C header')
    .requiredOption('--output <file>', 'Generated enum header destination')
    .parse(process.argv);
const options = program.opts();

const witDir = path.resolve(options.wit);
const bundle = fs.readFileSync(path.resolve(options.bundle), 'utf8');
const headerPath = path.resolve(options.header);
const outputPath = path.resolve(options.output);
const header = fs.readFileSync(headerPath, 'utf8');
const entries = [
    ['eventTypes', 'event.wit', 'event-type', 'PUMPKIN_PLUGIN_EVENT_EVENT_TYPE_'],
    ['eventPriorities', 'event.wit', 'event-priority', 'PUMPKIN_PLUGIN_EVENT_EVENT_PRIORITY_'],
    ['gameRules', 'game-rules.wit', 'game-rule', 'PUMPKIN_PLUGIN_GAME_RULES_GAME_RULE_'],
    ['namedColors', 'common.wit', 'named-color', 'PUMPKIN_PLUGIN_COMMON_NAMED_COLOR_'],
].map(([name, file, witEnum, cPrefix]) => {
    const requiresBundleMatch = name === 'eventTypes' || name === 'eventPriorities';
    const values = enumVariants(path.join(witDir, file), witEnum)
        .filter((variant) => !requiresBundleMatch || bundleUsesString(bundle, variant))
        .map((variant) => {
            const cName = `${cPrefix}${variant.toUpperCase().replaceAll('-', '_')}`;
            if (!new RegExp(`^#define ${cName} \\d+$`, 'm').test(header)) {
                throw new Error(`Generated Pumpkin C bindings are missing ${cName}`);
            }
            return { variant, cName };
        });
    return { name, values };
});
const source = /* cpp */ `// Generated from @pumpkin-plugins/pumpkin-api WIT and wit-bindgen C bindings. Do not edit.
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
        ({ name, values }) => /* cpp */ `inline constexpr std::array<EnumEntry, ${values.length}> ${name}{{
${values.map(({ variant, cName }) => `  {"${variant}", ${cName}},`).join('\n')}
}};`,
    )
    .join('\n\n')}
} // namespace pumpkin_static_api
`;

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
const temporaryPath = `${outputPath}.${process.pid}.tmp`;
try {
    fs.writeFileSync(temporaryPath, source);
    fs.renameSync(temporaryPath, outputPath);
} finally {
    fs.rmSync(temporaryPath, { force: true });
}

/** Check whether the bundle contains a WIT enum value as a quoted string. */
function bundleUsesString(bundle, value) {
    return bundle.includes(JSON.stringify(value)) || bundle.includes(`'${value}'`);
}

/** Parse the supported case names from a WIT enum declaration. */
function enumVariants(witPath, enumName) {
    const source = fs.readFileSync(witPath, 'utf8');
    const marker = new RegExp(`\\benum\\s+${enumName}\\s*\\{`, 'g');
    const match = marker.exec(source);
    if (!match) throw new Error(`WIT enum ${enumName} not found in ${witPath}`);
    const start = marker.lastIndex;
    let depth = 1;
    let end = start;
    while (end < source.length && depth > 0) {
        if (source[end] === '{') depth++;
        else if (source[end] === '}') depth--;
        end++;
    }
    if (depth !== 0) throw new Error(`WIT enum ${enumName} is not closed in ${witPath}`);
    const body = source
        .slice(start, end - 1)
        .replace(/\/\/[^\n]*/g, '')
        .split(',')
        .map((variant) => variant.trim())
        .filter(Boolean);
    if (body.length === 0 || body.some((variant) => !/^[a-z0-9-]+$/.test(variant))) {
        throw new Error(`Unsupported WIT enum syntax for ${enumName} in ${witPath}`);
    }
    return body;
}
