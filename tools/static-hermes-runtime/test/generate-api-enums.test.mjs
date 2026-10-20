import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(packageRoot, 'dist/cli.js');
const template = path.join(packageRoot, 'src/component/templates/runtime-shim.template');
const directories = [];

function fixture(imports = '') {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'static-hermes-api-enums-'));
    directories.push(root);
    const wit = path.join(root, 'wit');
    fs.mkdirSync(wit);
    fs.writeFileSync(
        path.join(wit, 'plugin.wit'),
        `package pumpkin:plugin@0.1.0;\nworld plugin {\n  import event;\n  import game-rules;\n  import common;\n${imports}\n}\n`,
    );
    fs.writeFileSync(
        path.join(wit, 'event.wit'),
        'interface event { enum event-type { tick, join } enum event-priority { normal, low } }\n',
    );
    fs.writeFileSync(
        path.join(wit, 'game-rules.wit'),
        'interface game-rules { enum game-rule { do-daylight-cycle } }\n',
    );
    fs.writeFileSync(path.join(wit, 'common.wit'), 'interface common { enum named-color { red, green } }\n');
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
            '#define PUMPKIN_PLUGIN_COMMON_NAMED_COLOR_GREEN 10',
        ].join('\n'),
    );
    return { root, wit, header, output: path.join(root, 'out') };
}

/** Run the compiled `codegen generate` command and return the generated enum header. */
function generate({ wit, header, output }, wasiImports = []) {
    childProcess.execFileSync(
        process.execPath,
        [
            cli,
            'codegen',
            'generate',
            '--wit',
            wit,
            '--template',
            template,
            '--header',
            header,
            '--out-dir',
            output,
            '--wasi-imports',
            JSON.stringify(wasiImports),
        ],
        { cwd: packageRoot, stdio: 'pipe' },
    );
    return fs.readFileSync(path.join(output, 'api-enums.generated.h'), 'utf8');
}

afterEach(() => {
    for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('codegen generate API enums', () => {
    it('keeps WASI enum tables out of the generated Pumpkin enum header', () => {
        const f = fixture('  import wasi:filesystem/types@0.2.3;');
        fs.mkdirSync(path.join(f.wit, 'deps/filesystem'), { recursive: true });
        fs.writeFileSync(
            path.join(f.wit, 'deps/filesystem/types.wit'),
            'package wasi:filesystem@0.2.3; interface types { enum error-code { access } }\n',
        );

        const output = generate(f, ['wasi:filesystem/types@0.2.3']);

        expect(output).not.toMatch(/wasiFilesystem|WASI_FILESYSTEM/);
    }, 15_000);

    it('generates named color enum values from Pumpkin WIT and wit-bindgen', () => {
        const output = generate(fixture());

        expect(output).toContain('#include "plugin.h"');
        expect(output).toContain('inline constexpr std::array<EnumEntry, 2> namedColors');
        expect(output).toContain('{"red", PUMPKIN_PLUGIN_COMMON_NAMED_COLOR_RED}');
        expect(output).toContain('{"green", PUMPKIN_PLUGIN_COMMON_NAMED_COLOR_GREEN}');
    }, 15_000);
});
