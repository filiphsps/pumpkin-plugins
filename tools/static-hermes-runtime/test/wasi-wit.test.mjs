import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { setupHermesToolchainEnvironment } from '../src/hermes/toolchain-environment.ts';
import { emitWasiFacade } from '../src/wit/emitters.ts';
import { readInterfaceDeclarationOrder, readPluginImportOrder, readWitToolsDocument } from '../src/wit/parser.ts';
import { resolveWasiImports, resolveWitDocument } from '../src/wit/resolver.ts';

const directories = [];
let wasmTools;

beforeAll(async () => {
    const toolchain = await setupHermesToolchainEnvironment({
        workspaceRoot: path.resolve(import.meta.dirname, '../../..'),
        includeWasiSdk: false,
        includeWitBindgen: false,
        includeWasmTools: true,
    });
    wasmTools = process.env.WASM_TOOLS ?? toolchain.WASM_TOOLS;
}, 120_000);

/** Resolve the plugin world's WASI imports the way `codegen generate` does. */
function readWasiWitImports(root, requestedImports) {
    const importOrder = readPluginImportOrder(root);
    const resolved = resolveWitDocument(
        readWitToolsDocument(root, { executable: wasmTools }),
        readInterfaceDeclarationOrder(root),
    );
    return resolveWasiImports(resolved, requestedImports, importOrder);
}

function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'static-hermes-wasi-wit-'));
    directories.push(root);
    write(
        root,
        'plugin.wit',
        `
        package pumpkin:plugin@0.1.0;
        world plugin {
            import wasi:filesystem/preopens@0.2.3;
            import wasi:http/outgoing-handler@0.2.3;
        }
    `,
    );
    write(
        root,
        'deps/filesystem/preopens.wit',
        `
        package wasi:filesystem@0.2.3;
        interface preopens {
            use types.{descriptor};
            get-directories: func() -> list<tuple<descriptor, string>>;
        }
    `,
    );
    write(
        root,
        'deps/filesystem/types.wit',
        `
        package wasi:filesystem@0.2.3;
        interface types {
            record descriptor-stat { size: u64 }
            resource descriptor {
                stat: func() -> descriptor-stat;
                open-at: func(path: string) -> descriptor;
            }
        }
    `,
    );
    write(root, 'deps/http/package.wit', 'package wasi:http@0.2.3;');
    write(
        root,
        'deps/http/outgoing-handler.wit',
        `
        interface outgoing-handler {
            use types.{outgoing-request, request-options, future-incoming-response};
            handle: func(request: outgoing-request, options: option<request-options>) -> result<future-incoming-response>;
        }
    `,
    );
    write(
        root,
        'deps/http/types.wit',
        `
        interface types {
            resource fields { constructor(); set: func(name: string, value: string); }
            resource outgoing-request { constructor(headers: fields); }
            resource request-options { constructor(); }
            resource future-incoming-response;
        }
    `,
    );
    write(
        root,
        'deps/io/poll.wit',
        `
        package wasi:io@0.2.3;
        interface poll { resource pollable { ready: func() -> bool; } }
    `,
    );
    write(
        root,
        'deps/clocks/timezone.wit',
        `
        package wasi:clocks@0.2.3;
        interface timezone { utc-offset: func() -> s32; }
    `,
    );
    return root;
}

function transitiveDependencyFixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'static-hermes-wasi-dependency-'));
    directories.push(root);
    write(root, 'plugin.wit', 'package pumpkin:plugin@0.1.0; world plugin { import wasi:test/parent@0.2.3; }');
    write(
        root,
        'deps/test/parent.wit',
        'package wasi:test@0.2.3; interface parent { use wasi:io/error@0.2.3.{error}; resource wrapper { get: func() -> error; } }',
    );
    write(
        root,
        'deps/io/error.wit',
        'package wasi:io@0.2.3; interface error { resource error { to-debug-string: func() -> string; } }',
    );
    return root;
}

function write(root, relativePath, contents) {
    const file = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
}

async function loadFacade(root, apiInterface, name) {
    const modulePath = path.join(root, `${name}-facade.mjs`);
    fs.writeFileSync(modulePath, emitWasiFacade(apiInterface));
    return import(pathToFileURL(modulePath).href);
}

function setGlobal(name, value) {
    const previous = globalThis[name];
    globalThis[name] = value;
    return () => {
        if (previous === undefined) Reflect.deleteProperty(globalThis, name);
        else globalThis[name] = previous;
    };
}

afterEach(() => {
    for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('WASI WIT generation', () => {
    it('allows selecting a transitive dependency interface', () => {
        const { interfaces } = readWasiWitImports(transitiveDependencyFixture(), ['wasi:io/error@0.2.3']);

        expect(interfaces.map((api) => api.specifier)).toEqual(['wasi:io/error@0.2.3']);
    });

    it('reads imported interfaces and follows only their WIT dependencies', () => {
        const wit = readWasiWitImports(fixture());

        expect(wit.imports).toEqual(['wasi:filesystem/preopens@0.2.3', 'wasi:http/outgoing-handler@0.2.3']);
        expect(wit.interfaces.map((api) => api.specifier)).toEqual([
            'wasi:filesystem/preopens@0.2.3',
            'wasi:filesystem/types@0.2.3',
            'wasi:http/outgoing-handler@0.2.3',
            'wasi:http/types@0.2.3',
        ]);
        expect(wit.interfaces.map((api) => api.name)).not.toContain('timezone');
    });

    it('forwards WASI function results through resource proxies with disposal', async () => {
        const root = fixture();
        const wit = readWasiWitImports(root);
        const preopens = wit.interfaces.find((api) => api.name === 'preopens');
        let dropped = false;
        let valid = true;
        const descriptor = {
            stat() {
                return { size: 4 };
            },
            get __isValid() {
                return valid;
            },
            drop() {
                dropped = true;
                valid = false;
            },
        };
        const restoreHost = setGlobal('__pumpkinWasiFilesystemPreopens', {
            getDirectories: () => [[descriptor, '/tmp']],
        });

        try {
            const { getDirectories } = await loadFacade(root, preopens, 'filesystem-preopens');

            const [[directory, path]] = getDirectories();

            expect(path).toBe('/tmp');
            expect(directory.__staticHermesWasiResource).toBe(descriptor);
            expect(directory.stat().size).toBe(4);
            directory[Symbol.dispose]();
            expect(dropped).toBe(true);
            expect(() => directory.stat()).toThrow('Cannot use a disposed or transferred resource');
        } finally {
            restoreHost();
        }
    });

    it('unwraps WASI resource constructor arguments before calling the host adapter', async () => {
        const root = fixture();
        const wit = readWasiWitImports(root);
        const httpTypes = wit.interfaces.find((api) => api.name === 'types' && api.packageName === 'wasi:http');
        const calls = [];
        const fields = { set: (name, value) => calls.push({ name, value }) };
        const request = {};
        const restoreHost = setGlobal('__pumpkinWasiHttpTypes', {
            fields: {
                constructor: () => fields,
            },
            outgoingRequest: {
                constructor: (headers) => {
                    calls.push({ headers });
                    return request;
                },
            },
        });

        try {
            const { Fields, OutgoingRequest } = await loadFacade(root, httpTypes, 'http-types');

            const headers = new Fields();
            headers.set('Accept', 'application/json');
            const outgoingRequest = new OutgoingRequest(headers);

            expect(calls).toEqual([{ name: 'Accept', value: 'application/json' }, { headers: fields }]);
            expect(outgoingRequest.__staticHermesWasiResource).toBe(request);
        } finally {
            restoreHost();
        }
    });

    it('rejects WASI imports that are not declared by the plugin world', () => {
        expect(() => readWasiWitImports(fixture(), ['wasi:sockets/tcp@0.2.3'])).toThrow(
            'WASI interface wasi:sockets/tcp@0.2.3 is not imported by plugin WIT',
        );
    });

    it('reads package declarations from a package world file for sibling interfaces', () => {
        const root = fixture();
        const pluginPath = path.join(root, 'plugin.wit');
        fs.writeFileSync(
            pluginPath,
            fs
                .readFileSync(pluginPath, 'utf8')
                .replace('import wasi:http/outgoing-handler@0.2.3;', 'import wasi:sockets/tcp-create-socket@0.2.3;'),
        );
        write(
            root,
            'deps/sockets/world.wit',
            'package wasi:sockets@0.2.3; world imports { import network; import tcp-create-socket; }',
        );
        write(root, 'deps/sockets/network.wit', 'interface network { resource network; enum error-code { unknown } }');
        write(
            root,
            'deps/sockets/tcp-create-socket.wit',
            'interface tcp-create-socket { use network.{network, error-code}; create-tcp-socket: func() -> result<network, error-code>; }',
        );

        const wit = readWasiWitImports(root);

        expect(wit.interfaces.map((api) => api.specifier)).toEqual([
            'wasi:filesystem/preopens@0.2.3',
            'wasi:filesystem/types@0.2.3',
            'wasi:sockets/tcp-create-socket@0.2.3',
            'wasi:sockets/network@0.2.3',
        ]);
        expect(wit.interfaces.find((api) => api.name === 'network').resources).toEqual([
            { name: 'network', functions: [] },
        ]);
    });
});
