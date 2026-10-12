#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
    const key = process.argv[index];
    const value = process.argv[index + 1];
    if (!key?.startsWith('--') || !value) throw new Error(`Invalid argument near ${key ?? '(end)'}`);
    args.set(key.slice(2), value);
}

const witDir = required('wit');
const headerPath = required('header');
const outputPath = required('output');
const header = fs.readFileSync(headerPath, 'utf8');
const entries = [
    ['eventTypes', 'event.wit', 'event-type', 'PUMPKIN_PLUGIN_EVENT_EVENT_TYPE_'],
    ['eventPriorities', 'event.wit', 'event-priority', 'PUMPKIN_PLUGIN_EVENT_EVENT_PRIORITY_'],
    ['gameRules', 'game-rules.wit', 'game-rule', 'PUMPKIN_PLUGIN_GAME_RULES_GAME_RULE_']
].map(([name, file, witEnum, cPrefix]) => ({
    name,
    values: enumVariants(path.join(witDir, file), witEnum).map((variant) => {
        const cName = `${cPrefix}${variant.toUpperCase().replaceAll('-', '_')}`;
        if (!new RegExp(`^#define ${cName} \\d+$`, 'm').test(header)) {
            throw new Error(`Generated Pumpkin C bindings are missing ${cName}`);
        }
        return { variant, cName };
    })
}));

const source = `// Generated from pumpkin-api-ts WIT and wit-bindgen C bindings. Do not edit.
#pragma once
#include <cstdint>
#include <string_view>

namespace pumpkin_static_api {
struct EnumEntry {
  std::string_view name;
  uint32_t value;
};
${entries
    .map(
        ({ name, values }) => `inline constexpr EnumEntry ${name}[] = {
${values.map(({ variant, cName }) => `  {"${variant}", ${cName}},`).join('\n')}
};`
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

function required(name) {
    const value = args.get(name);
    if (!value) throw new Error(`Missing --${name}`);
    return path.resolve(value);
}

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
