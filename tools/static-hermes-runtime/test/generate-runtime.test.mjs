import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(packageRoot, 'dist/cli.js');
const fixtures = path.join(packageRoot, 'test/fixtures');
const directories = [];

function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'static-hermes-runtime-generator-'));
    directories.push(root);
    const wit = path.join(root, 'wit');
    fs.mkdirSync(wit);
    fs.writeFileSync(
        path.join(wit, 'plugin.wit'),
        'package pumpkin:plugin@0.1.0;\nworld plugin {\n  import %world;\n  import context;\n  import server;\n  import player;\n  import command;\n  import text;\n  import common;\n  import game-rules;\n  import event;\n  import wasi:filesystem/preopens@0.2.3;\n  import wasi:http/types@0.2.3;\n  import wasi:http/outgoing-handler@0.2.3;\n  import wasi:io/streams@0.2.3;\n  import wasi:clocks/monotonic-clock@0.2.3;\n  export init: func();\n}\n',
    );
    fs.writeFileSync(
        path.join(wit, 'world.wit'),
        'interface %world { resource %world { get-min-y: func() -> s32; } }\n',
    );
    fs.writeFileSync(
        path.join(wit, 'context.wit'),
        'interface context { use server.{server}; resource context { get-server: func() -> server; } }\n',
    );
    fs.writeFileSync(
        path.join(wit, 'server.wit'),
        'interface server { use %world.{%world}; resource server { get-mspt: func() -> f64; get-all-worlds: func() -> list<%world>; } }\n',
    );
    fs.writeFileSync(
        path.join(wit, 'player.wit'),
        'interface player { resource player { get-saturation: func() -> f32; } }\n',
    );
    fs.writeFileSync(path.join(wit, 'command.wit'), 'interface command { resource command { then: func(); } }\n');
    fs.writeFileSync(
        path.join(wit, 'text.wit'),
        'interface text { resource text-component { color-named: func(); } }\n',
    );
    fs.writeFileSync(
        path.join(wit, 'common.wit'),
        'interface common { record block-pos { x: s32, y: s32, z: s32 } enum named-color { red } }\n',
    );
    fs.writeFileSync(path.join(wit, 'game-rules.wit'), 'interface game-rules { enum game-rule { keep-inventory } }\n');
    fs.writeFileSync(
        path.join(wit, 'event.wit'),
        'interface event { enum event-type { player-custom-payload-event } enum event-priority { normal } record player-custom-payload-event-data { channel: string, data: list<u8> } variant event { player-custom-payload-event(player-custom-payload-event-data) } }\n',
    );
    const wasiDefinitions = {
        'filesystem/preopens.wit':
            'package wasi:filesystem@0.2.3; interface preopens { use types.{descriptor}; get-directories: func() -> list<tuple<descriptor, string>>; }\n',
        'filesystem/types.wit':
            'package wasi:filesystem@0.2.3; interface types { resource descriptor { stat: func() -> u32; } }\n',
        'http/types.wit':
            'package wasi:http@0.2.3; interface types { enum error-code { protocol-error } resource fields { constructor(); set: func(); } resource outgoing-request { constructor(headers: fields); } resource request-options { constructor(); } resource incoming-body; resource incoming-response { consume: func() -> result<incoming-body, error-code>; } resource future-incoming-response { get: func() -> result<option<incoming-response>, error-code>; } }\n',
        'http/outgoing-handler.wit':
            'package wasi:http@0.2.3; interface outgoing-handler { use types.{outgoing-request, request-options}; handle: func(request: outgoing-request, options: option<request-options>); }\n',
        'io/streams.wit':
            'package wasi:io@0.2.3; interface streams { variant stream-error { closed } resource input-stream { read: func(len: u64) -> result<list<u8>, stream-error>; } }\n',
        'clocks/monotonic-clock.wit': 'package wasi:clocks@0.2.3; interface monotonic-clock { now: func() -> u64; }\n',
    };
    for (const [relativePath, source] of Object.entries(wasiDefinitions)) {
        const file = path.join(wit, 'deps', relativePath);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, source);
    }
    const header = path.join(root, 'plugin.h');
    fs.writeFileSync(
        header,
        [
            '#define PUMPKIN_PLUGIN_EVENT_EVENT_TYPE_PLAYER_CUSTOM_PAYLOAD_EVENT 0',
            '#define PUMPKIN_PLUGIN_EVENT_EVENT_PRIORITY_NORMAL 0',
            '#define PUMPKIN_PLUGIN_GAME_RULES_GAME_RULE_KEEP_INVENTORY 0',
            '#define PUMPKIN_PLUGIN_COMMON_NAMED_COLOR_RED 0',
        ].join('\n'),
    );
    const template = path.join(packageRoot, 'src/component/templates/runtime-shim.template');
    const outDir = path.join(root, 'out');
    return { root, wit, template, header, outDir, output: path.join(outDir, 'runtime.cpp') };
}

function addUnreadableWasiRuntime(witDir) {
    const pluginPath = path.join(witDir, 'plugin.wit');
    const pluginSource = fs.readFileSync(pluginPath, 'utf8');
    fs.writeFileSync(
        pluginPath,
        pluginSource.replace('  export init: func();', '  import wasi:test/runtime@0.2.3;\n  export init: func();'),
    );
    const dependencyDir = path.join(witDir, 'deps/test');
    fs.mkdirSync(dependencyDir, { recursive: true });
    fs.writeFileSync(
        path.join(dependencyDir, 'world.wit'),
        'package wasi:test@0.2.3; world imports { import runtime; }\n',
    );
    fs.writeFileSync(
        path.join(dependencyDir, 'runtime.wit'),
        'package wasi:test@0.2.3; interface runtime { unsupported: func(value: future<u32>); }\n',
    );
}

/** Run the compiled `codegen generate` command for the fixture and its WASI selection. */
function generate({ wit, template, header, outDir, wasiImports, wasiMethods }) {
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
            outDir,
            '--wasi-imports',
            JSON.stringify(wasiImports),
            ...(wasiMethods === undefined ? [] : ['--wasi-methods', JSON.stringify(wasiMethods)]),
        ],
        { cwd: packageRoot, stdio: 'pipe' },
    );
}

function compileAndRunCpp(root, source) {
    const input = path.join(root, 'runtime-contract.cpp');
    const executable = path.join(root, 'runtime-contract');
    fs.writeFileSync(input, source);
    childProcess.execFileSync(process.env.CXX ?? 'c++', ['-std=c++17', '-I', fixtures, input, '-o', executable], {
        stdio: 'pipe',
    });
    childProcess.execFileSync(executable, [], { stdio: 'pipe' });
}

function compileFixture(root, filename, generatedBlocks = {}) {
    let source = fs.readFileSync(path.join(fixtures, filename), 'utf8');
    for (const [marker, block] of Object.entries(generatedBlocks)) {
        if (source.split(marker).length !== 2) throw new Error(`fixture must contain exactly one ${marker} marker`);
        source = source.replace(marker, block);
    }
    compileAndRunCpp(root, source);
}

function generatedBlock(source, marker) {
    const start = source.indexOf(marker);
    if (start < 0) throw new Error(`generated source is missing ${marker}`);
    const open = source.indexOf('{', start);
    if (open < 0) throw new Error(`generated source has no body for ${marker}`);
    let depth = 0;
    for (let index = open; index < source.length; index++) {
        if (source[index] === '{') depth++;
        if (source[index] === '}' && --depth === 0) return source.slice(start, index + 1);
    }
    throw new Error(`generated source has an unclosed body for ${marker}`);
}

afterEach(() => {
    for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('codegen generate', () => {
    it('fails without writing runtime source when the WIT uses an async future type', () => {
        const f = fixture();
        addUnreadableWasiRuntime(f.wit);
        f.wasiImports = [];

        let failure;
        try {
            generate(f);
        } catch (error) {
            failure = error;
        }

        expect(failure).toBeDefined();
        expect(failure.stderr?.toString()).toContain('Unsupported WIT JSON type kind "future"');
        expect(fs.existsSync(f.output)).toBe(false);
    });

    it('passes command IDs and owned resources to the plugin command callback', () => {
        const f = fixture();
        f.wasiImports = [];

        generate(f);

        const output = fs.readFileSync(f.output, 'utf8');
        const handler = generatedBlock(output, 'bool exports_plugin_handle_command(');
        compileFixture(f.root, 'generate-runtime/command-handler.cpp', {
            '/* GENERATED_COMMAND_HANDLER */': handler,
        });
    }, 15_000);

    it('invalidates server wrappers after event and task callbacks', () => {
        const f = fixture();
        f.wasiImports = [];

        generate(f);

        const output = fs.readFileSync(f.output, 'utf8');
        const resourceState = generatedBlock(output, 'std::shared_ptr<ResourceState>\ngetWitResourceState(');
        const eventHandler = generatedBlock(output, 'void exports_plugin_handle_event(');
        const taskHandler = generatedBlock(output, 'void exports_plugin_handle_task(');
        compileFixture(f.root, 'server-callback-lifetime.cpp', {
            '/* GENERATED_GET_WIT_RESOURCE_STATE */': resourceState,
            '/* GENERATED_EVENT_CALLBACK */': eventHandler,
            '/* GENERATED_TASK_CALLBACK */': taskHandler,
        });
    }, 15_000);

    it('dispatches command suggestions and marshals values, tooltips, and owned inputs', () => {
        const f = fixture();
        f.wasiImports = [];

        generate(f);

        const output = fs.readFileSync(f.output, 'utf8');
        const handler = generatedBlock(output, 'void exports_plugin_handle_command_suggestion(');
        compileFixture(f.root, 'generate-runtime/command-suggestion-handler.cpp', {
            '/* GENERATED_COMMAND_SUGGESTION_HANDLER */': handler,
        });
    }, 15_000);

    it('returns runtime initialization errors and releases the owned plugin context', () => {
        const f = fixture();
        f.wasiImports = [];

        generate(f);

        const output = fs.readFileSync(f.output, 'utf8');
        const onLoad = generatedBlock(output, 'bool exports_plugin_on_load(');
        compileFixture(f.root, 'generate-runtime/plugin-on-load.cpp', {
            '/* GENERATED_PLUGIN_ON_LOAD */': onLoad,
        });
    }, 15_000);

    it('generates string and byte-list event payloads from imported WIT', () => {
        const f = fixture();
        f.wasiImports = [];

        generate(f);

        const output = fs.readFileSync(f.output, 'utf8');
        const eventDispatch = generatedBlock(output, 'switch (event->tag)');
        compileFixture(f.root, 'generate-runtime/wit-event.cpp', {
            '/* GENERATED_WIT_EVENT_DISPATCH */': eventDispatch,
        });
    }, 15_000);

    it('generates only selected WASI adapters from their WIT declarations', () => {
        const f = fixture();
        f.wasiImports = ['wasi:clocks/monotonic-clock@0.2.3'];
        f.wasiMethods = ['wasi:clocks/monotonic-clock@0.2.3#now'];

        generate(f);

        const output = fs.readFileSync(f.output, 'utf8');
        expect(output).toContain('generatedMonotonicClockApi.setProperty');
        expect(output).toContain('wasi_clocks_monotonic_clock_now()');
        expect(output).toContain('__pumpkinWasiClocksMonotonicClock');
        expect(output).not.toContain('__pumpkinWasiHttpTypes');
    });

    it('generates an adapter for a selected WASI method outside the selected imports', () => {
        const f = fixture();
        f.wasiImports = ['wasi:http/types@0.2.3', 'wasi:http/outgoing-handler@0.2.3'];
        f.wasiMethods = ['wasi:clocks/monotonic-clock@0.2.3#now'];

        generate(f);

        const output = fs.readFileSync(f.output, 'utf8');
        expect(output).toContain('wasi_clocks_monotonic_clock_now');
    });

    it('generates HTTP constructors and future methods from the imported WIT', () => {
        const f = fixture();
        f.wasiImports = ['wasi:http/types@0.2.3'];
        f.wasiMethods = [
            'wasi:http/types@0.2.3#fields.constructor',
            'wasi:http/types@0.2.3#outgoing-request.constructor',
            'wasi:http/types@0.2.3#future-incoming-response.get',
        ];

        generate(f);

        const output = fs.readFileSync(f.output, 'utf8');
        expect(output).toContain('wasi_http_types_constructor_fields()');
        expect(output).toContain('wasi_http_types_constructor_outgoing_request');
        expect(output).toContain('wasi_http_types_method_future_incoming_response_get');
        expect(output).toContain('__pumpkinWasiHttpTypes');
    });

    it('wraps a returned WASI resource handle as an owned host resource', () => {
        const f = fixture();
        f.wasiImports = ['wasi:http/outgoing-handler@0.2.3'];
        f.wasiMethods = ['wasi:http/types@0.2.3#incoming-response.consume'];

        generate(f);

        const output = fs.readFileSync(f.output, 'utf8');
        const resourceMethod = generatedBlock(output, 'Value generatedWasiResourceMethod(Runtime &runtime');
        compileFixture(f.root, 'generate-runtime/wasi-resource-result.cpp', {
            '/* GENERATED_WASI_RESOURCE_METHOD */': resourceMethod,
        });
    }, 15_000);

    it('generates input-stream reads as WIT byte-list results', () => {
        const f = fixture();
        f.wasiImports = ['wasi:io/streams@0.2.3'];
        f.wasiMethods = ['wasi:io/streams@0.2.3#input-stream.read'];

        generate(f);

        const output = fs.readFileSync(f.output, 'utf8');
        const readAdapter = output.slice(output.indexOf('"input-stream" && methodName == "read"'));
        expect(readAdapter).toContain('wasi_io_streams_method_input_stream_read');
        expect(readAdapter).toContain('Uint8Array resultValue');
        expect(readAdapter).not.toContain('Value::null()');
    });

    it('fails when an imported interface is not present in plugin WIT', () => {
        const f = fixture();
        f.wasiImports = ['wasi:sockets/tcp@0.2.3'];

        expect(() => generate(f)).toThrow(/WASI interface wasi:sockets\/tcp@0\.2\.3 is not imported by plugin WIT/);
    });
});
