import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const generator = path.join(packageRoot, 'bin/generate-api-enums.mjs');
const directories = [];

function fixture(imports = '') {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'static-hermes-api-enums-'));
    directories.push(root);
    const wit = path.join(root, 'wit');
    fs.mkdirSync(wit);
    fs.writeFileSync(path.join(wit, 'plugin.wit'), `world plugin {\n${imports}\n}\n`);
    fs.writeFileSync(
        path.join(wit, 'event.wit'),
        'enum event-type { tick, join }\nenum event-priority { normal, low }\n'
    );
    fs.writeFileSync(path.join(wit, 'game-rules.wit'), 'enum game-rule { do-daylight-cycle }\n');
    fs.writeFileSync(path.join(wit, 'common.wit'), 'enum named-color { red, green }\n');
    const header = path.join(root, 'plugin.h');
    fs.writeFileSync(
        header,
        [
            '#define PUMPKIN_PLUGIN_EVENT_EVENT_TYPE_TICK 0',
            '#define PUMPKIN_PLUGIN_EVENT_EVENT_TYPE_JOIN 1',
            '#define PUMPKIN_PLUGIN_EVENT_EVENT_PRIORITY_NORMAL 0',
            '#define PUMPKIN_PLUGIN_EVENT_EVENT_PRIORITY_LOW 1',
            '#define PUMPKIN_PLUGIN_GAME_RULES_GAME_RULE_DO_DAYLIGHT_CYCLE 0',
            '#define PUMPKIN_PLUGIN_COMMON_NAMED_COLOR_RED 12',
            '#define PUMPKIN_PLUGIN_COMMON_NAMED_COLOR_GREEN 10'
        ].join('\n')
    );
    const bundle = path.join(root, 'bundle.js');
    fs.writeFileSync(bundle, 'registerEvent("tick", "normal");');
    return { root, wit, header, bundle, output: path.join(root, 'api-enums.generated.h') };
}

function generate({ wit, header, bundle, output }) {
    childProcess.execFileSync(
        process.execPath,
        [generator, '--wit', wit, '--bundle', bundle, '--header', header, '--output', output],
        { stdio: 'pipe' }
    );
}

afterEach(() => {
    for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('generate-api-enums', () => {
    it('keeps WASI enum tables out of the generated Pumpkin enum header', () => {
        const f = fixture('  import wasi:filesystem/types@0.2.3;');

        generate(f);

        const output = fs.readFileSync(f.output, 'utf8');
        expect(output).not.toContain('wasiFilesystem');
    });

    it('generates named color enum values from Pumpkin WIT and wit-bindgen', () => {
        const f = fixture();

        generate(f);

        const output = fs.readFileSync(f.output, 'utf8');
        expect(output).toContain('#include "plugin.h"');
        expect(output).toContain('inline constexpr std::array<EnumEntry, 2> namedColors');
        expect(output).toContain('{"red", PUMPKIN_PLUGIN_COMMON_NAMED_COLOR_RED}');
        expect(output).toContain('{"green", PUMPKIN_PLUGIN_COMMON_NAMED_COLOR_GREEN}');
    });

    it('keeps only event names and priorities referenced by the plugin bundle', () => {
        const f = fixture();

        generate(f);

        const output = fs.readFileSync(f.output, 'utf8');
        expect(output).toContain('{"tick", PUMPKIN_PLUGIN_EVENT_EVENT_TYPE_TICK}');
        expect(output).not.toContain('PUMPKIN_PLUGIN_EVENT_EVENT_TYPE_JOIN');
        expect(output).toContain('{"normal", PUMPKIN_PLUGIN_EVENT_EVENT_PRIORITY_NORMAL}');
        expect(output).not.toContain('PUMPKIN_PLUGIN_EVENT_EVENT_PRIORITY_LOW');
    });

    it('generates valid empty event tables when the plugin registers no events', () => {
        const f = fixture();
        fs.writeFileSync(f.bundle, '');

        generate(f);

        const output = fs.readFileSync(f.output, 'utf8');
        expect(output).toContain('std::array<EnumEntry, 0> eventTypes');
        expect(output).toContain('std::array<EnumEntry, 0> eventPriorities');
    });
});
