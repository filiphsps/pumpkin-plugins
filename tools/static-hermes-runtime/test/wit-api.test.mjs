import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { setupHermesToolchainEnvironment } from '../src/hermes/toolchain-environment.ts';
import { analyzeWitUsage } from '../src/wit/analysis.ts';
import {
    emitEventDispatch,
    emitPumpkinFacade,
    emitPumpkinMethodDispatch,
    emitWasiAdapterDispatch,
    emitWasiFacade,
} from '../src/wit/emitters.ts';
import { readInterfaceDeclarationOrder, readPluginImportOrder, readWitToolsDocument } from '../src/wit/parser.ts';
import { resolvePluginApi, resolveWitDocument } from '../src/wit/resolver.ts';

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

/** Resolve a WIT directory and analyze one operation selection the way `codegen generate` does. */
function resolveWit(root, selection = {}) {
    const pluginImportOrder = readPluginImportOrder(root);
    const resolved = resolveWitDocument(
        readWitToolsDocument(root, { executable: wasmTools }),
        readInterfaceDeclarationOrder(root),
    );
    return {
        apiPackage: resolvePluginApi(resolved, pluginImportOrder),
        analysis: analyzeWitUsage(resolved, { pluginImportOrder, ...selection }),
    };
}

/** Generate native Pumpkin dispatch for the selected operations, or for every operation when omitted. */
function methodDispatch(root, apiMethods) {
    const { apiPackage, analysis } = resolveWit(root, apiMethods === undefined ? {} : { apiMethods });
    return emitPumpkinMethodDispatch(apiPackage, analysis);
}

/** Generate native event conversion for every declared event. */
function eventDispatch(root) {
    const { apiPackage, analysis } = resolveWit(root, { apiMethods: [] });
    return emitEventDispatch(apiPackage, analysis);
}

/** Plan and generate native WASI dispatch for the selected imports and operations. */
function wasiDispatch(root, wasiImports, wasiMethods) {
    const { analysis } = resolveWit(root, {
        apiMethods: [],
        wasiImports,
        ...(wasiMethods === undefined ? {} : { wasiMethods }),
    });
    return {
        analysis,
        plan: analysis.wasiAdapters.map(({ operationId }) => operationId),
        dispatch: emitWasiAdapterDispatch(analysis.resolvedWasiInterfaces, analysis),
    };
}

function writeWit(root, filename, source) {
    fs.mkdirSync(path.dirname(path.join(root, filename)), { recursive: true });
    fs.writeFileSync(path.join(root, filename), `${source.trim()}\n`);
}

function wasiSocketFixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'static-hermes-wasi-plan-'));
    directories.push(root);
    writeWit(
        root,
        'plugin.wit',
        `
            package pumpkin:plugin@0.1.0;
            world plugin {
                import wasi:sockets/instance-network@0.2.3;
            }
        `,
    );
    writeWit(
        root,
        'deps/sockets/world.wit',
        `
            package wasi:sockets@0.2.3;
            world imports {
                import network;
                import instance-network;
            }
        `,
    );
    writeWit(
        root,
        'deps/sockets/network.wit',
        `
            interface network {
                resource network { get-network-id: func() -> u32; }
                resource unused;
                @unstable(feature = network-error-code)
                network-error-code: func() -> option<u32>;
                unused-query: func() -> option<u32>;
            }
        `,
    );
    writeWit(
        root,
        'deps/sockets/instance-network.wit',
        `
            interface instance-network {
                use network.{network};
                instance-network: func() -> network;
            }
        `,
    );
    return root;
}

function wasiFilesystemFixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'static-hermes-wasi-filesystem-'));
    directories.push(root);
    writeWit(
        root,
        'plugin.wit',
        `
            package pumpkin:plugin@0.1.0;
            world plugin {
                import wasi:filesystem/types@0.2.3;
                import wasi:http/types@0.2.3;
            }
        `,
    );
    writeWit(root, 'deps/filesystem/world.wit', 'package wasi:filesystem@0.2.3; world imports { import types; }');
    writeWit(
        root,
        'deps/filesystem/types.wit',
        `
            package wasi:filesystem@0.2.3;
            interface types {
                use wasi:clocks/wall-clock@0.2.3.{datetime};
                enum error-code { access-denied }
                flags path-flags { symlink-follow }
                type filesize = u64;
                record descriptor-stat { data-modification-timestamp: option<datetime>, }
                resource descriptor {
                    read: func(length: filesize, offset: filesize) -> result<tuple<list<u8>, bool>, error-code>;
                    stat-at: func(path-flags: path-flags, path: string) -> result<descriptor-stat, error-code>;
                }
            }
        `,
    );
    writeWit(root, 'deps/http/world.wit', 'package wasi:http@0.2.3; world imports { import types; }');
    writeWit(
        root,
        'deps/http/types.wit',
        'package wasi:http@0.2.3; interface types { enum error-code { protocol-error } }',
    );
    writeWit(root, 'deps/clocks/world.wit', 'package wasi:clocks@0.2.3; world imports { import wall-clock; }');
    writeWit(
        root,
        'deps/clocks/wall-clock.wit',
        'package wasi:clocks@0.2.3; interface wall-clock { record datetime { seconds: u64, nanoseconds: u32, } }',
    );
    return root;
}

function wasiFilesystemPreopensFixture() {
    const root = wasiFilesystemFixture();
    writeWit(
        root,
        'plugin.wit',
        `
            package pumpkin:plugin@0.1.0;
            world plugin {
                import wasi:filesystem/preopens@0.2.3;
            }
        `,
    );
    writeWit(
        root,
        'deps/filesystem/world.wit',
        'package wasi:filesystem@0.2.3; world imports { import types; import preopens; }',
    );
    writeWit(
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
    return root;
}

function wasiHttpStreamFixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'static-hermes-http-stream-plan-'));
    directories.push(root);
    writeWit(
        root,
        'plugin.wit',
        `
            package pumpkin:plugin@0.1.0;
            world plugin {
                import wasi:http/types@0.2.3;
                import wasi:http/outgoing-handler@0.2.3;
                import wasi:clocks/monotonic-clock@0.2.3;
                import wasi:io/streams@0.2.3;
            }
        `,
    );
    writeWit(
        root,
        'deps/http/world.wit',
        'package wasi:http@0.2.3; world imports { import types; import outgoing-handler; }',
    );
    writeWit(
        root,
        'deps/http/types.wit',
        `
            package wasi:http@0.2.3;
            interface types {
                use wasi:io/error@0.2.3.{error as io-error};
                use wasi:clocks/monotonic-clock@0.2.3.{duration};
                enum error-code { protocol-error }
                record DNS-error-payload { rcode: option<string>, info-code: option<u16> }
                record TLS-alert-received-payload { alert-id: option<u8>, alert-message: option<string> }
                variant payload { DNS-error(DNS-error-payload), TLS-alert-received(TLS-alert-received-payload) }
                type field-value = list<u8>;
                type trailers = fields;
                variant scheme { http, https, other(string) }
                variant method { get, post, other(string) }
                echo-trailers: func(value: trailers) -> option<trailers>;
                accept-payload: func(value: payload);
                get-payload: func() -> payload;
                http-error-code: func(err: borrow<io-error>) -> option<error-code>;
                resource fields {
                    set: func(values: list<field-value>) -> result<_, error-code>;
                }
                resource outgoing-request {
                    set-method: func(method: method) -> result;
                    set-path-with-query: func(path-with-query: option<string>) -> result;
                    set-scheme: func(scheme: option<scheme>) -> result;
                }
                resource request-options {
                    set-connect-timeout: func(duration: option<duration>) -> result;
                }
                resource future-trailers {
                    get: func() -> option<result<result<option<trailers>, error-code>>>;
                }
            }
        `,
    );
    writeWit(
        root,
        'deps/http/outgoing-handler.wit',
        'package wasi:http@0.2.3; interface outgoing-handler { handle: func(); }',
    );
    writeWit(root, 'deps/clocks/world.wit', 'package wasi:clocks@0.2.3; world imports { import monotonic-clock; }');
    writeWit(
        root,
        'deps/clocks/monotonic-clock.wit',
        'package wasi:clocks@0.2.3; interface monotonic-clock { type duration = u64; now: func() -> u64; }',
    );
    writeWit(
        root,
        'deps/io/world.wit',
        'package wasi:io@0.2.3; world imports { import error; import poll; import streams; }',
    );
    writeWit(
        root,
        'deps/io/error.wit',
        'package wasi:io@0.2.3; interface error { resource error { to-debug-string: func() -> string; } }',
    );
    writeWit(
        root,
        'deps/io/poll.wit',
        'package wasi:io@0.2.3; interface poll { resource pollable { ready: func() -> bool; block: func(); } poll: func(in: list<borrow<pollable>>) -> list<u32>; }',
    );
    writeWit(
        root,
        'deps/io/streams.wit',
        'package wasi:io@0.2.3; interface streams { use error.{error}; use poll.{pollable}; variant stream-error { last-operation-failed(error), closed } resource input-stream { read: func(len: u64) -> result<list<u8>, stream-error>; subscribe: func() -> pollable; } }',
    );
    return root;
}

function wasiSocketAddressFixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'static-hermes-socket-address-'));
    directories.push(root);
    writeWit(
        root,
        'plugin.wit',
        `
            package pumpkin:plugin@0.1.0;
            world plugin {
                import wasi:sockets/tcp@0.2.3;
                import wasi:sockets/udp@0.2.3;
            }
        `,
    );
    writeWit(
        root,
        'deps/sockets/world.wit',
        'package wasi:sockets@0.2.3; world imports { import network; import tcp; import udp; }',
    );
    writeWit(
        root,
        'deps/sockets/network.wit',
        `
            interface network {
                resource network;
                enum error-code { unknown, invalid-argument }
                enum ip-address-family { ipv4, ipv6 }
                type ipv4-address = tuple<u8, u8, u8, u8>;
                type ipv6-address = tuple<u16, u16, u16, u16, u16, u16, u16, u16>;
                record ipv4-socket-address { port: u16, address: ipv4-address }
                record ipv6-socket-address { port: u16, flow-info: u32, address: ipv6-address, scope-id: u32 }
                variant ip-socket-address { ipv4(ipv4-socket-address), ipv6(ipv6-socket-address) }
            }
        `,
    );
    writeWit(
        root,
        'deps/sockets/tcp.wit',
        `
            interface tcp {
                use network.{network, error-code, ip-socket-address};
                resource tcp-socket {
                    start-bind: func(network: borrow<network>, local-address: ip-socket-address) -> result<_, error-code>;
                    start-connect: func(network: borrow<network>, remote-address: ip-socket-address) -> result<_, error-code>;
                    finish-connect: func() -> result<tuple<input-stream, output-stream>, error-code>;
                    accept: func() -> result<tuple<tcp-socket, input-stream, output-stream>, error-code>;
                }
                resource input-stream;
                resource output-stream;
            }
        `,
    );
    writeWit(
        root,
        'deps/sockets/udp.wit',
        `
            interface udp {
                use network.{network, error-code, ip-socket-address};
                record incoming-datagram { data: list<u8>, remote-address: ip-socket-address }
                record outgoing-datagram { data: list<u8>, remote-address: option<ip-socket-address> }
                resource udp-socket {
                    start-bind: func(network: borrow<network>, local-address: ip-socket-address) -> result<_, error-code>;
                    %stream: func(remote-address: option<ip-socket-address>) -> result<tuple<incoming-datagram-stream, outgoing-datagram-stream>, error-code>;
                }
                resource incoming-datagram-stream {
                    receive: func(max-results: u64) -> result<list<incoming-datagram>, error-code>;
                }
                resource outgoing-datagram-stream {
                    send: func(datagrams: list<outgoing-datagram>) -> result<u64, error-code>;
                }
            }
        `,
    );
    return root;
}

function wasiResourceOperationsFixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'static-hermes-wasi-resource-operations-'));
    directories.push(root);
    writeWit(
        root,
        'plugin.wit',
        `
            package pumpkin:plugin@0.1.0;
            world plugin {
                import wasi:test/runtime@0.2.3;
            }
        `,
    );
    writeWit(root, 'deps/test/world.wit', 'package wasi:test@0.2.3; world imports { import runtime; }');
    writeWit(
        root,
        'deps/test/runtime.wit',
        `
            package wasi:test@0.2.3;
            interface runtime {
                enum error-code { failed }
                resource handle {
                    constructor(value: u32);
                    value: func() -> u32;
                    create: static func(value: u32) -> result<handle, error-code>;
                    release: static func(handle: handle);
                }
            }
        `,
    );
    return root;
}

function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'static-hermes-wit-api-'));
    directories.push(root);
    writeWit(
        root,
        'plugin.wit',
        `
            package pumpkin:plugin@0.1.0;
            world plugin {
                import %world;
                import command;
                import server;
                import player;
                import context;
                import permission;
                import ipc;
            }
        `,
    );
    writeWit(
        root,
        'world.wit',
        `
            interface %world {
                use common.{block-pos};
                use biomes.{biome};
                use game-rules.{game-rule, game-rule-value};

                enum piston-behavior { normal, destroy, }
                record block-state { piston-behavior: piston-behavior, }

                resource %world {
                    constructor();
                    get-dimension: func() -> string;
                    get-world-border: func() -> world-border;
                    get-block-state-id: func(pos: block-pos) -> u16;
                    get-biome: func(pos: block-pos) -> biome;
                    get-game-rule: func(rule: game-rule) -> game-rule-value;
                    get-chunk: func(x: s32, z: s32) -> option<chunk>;
                    get-chunks: func() -> list<chunk>;
                    accept-entity-ids: func(ids: list<s32>);
                    get-entity-ids: func() -> list<s32>;
                }

                resource world-border {
                    get-center-x: func() -> f64;
                    get-center-z: func() -> f64;
                    get-size: func() -> f64;
                }

                resource chunk {
                    get-x: func() -> s32;
                }

                resolve-block-state: func(name: string, properties: list<tuple<string, string>>) -> option<u16>;
                get-block-state: func() -> block-state;
                block-state-to-info: func(state-id: u16) -> option<string>;
                lookup-added-by-api-update: func(name: string) -> option<u16>;
            }
        `,
    );
    writeWit(
        root,
        'command.wit',
        `
            interface command {
                use uuid.{uuid};
                use server.{server};

                resource command {
                    constructor(names: list<string>, description: string);
                    then: func(node: command-node);
                }

                resource command-node {
                    literal: static func(name: string) -> command-node;
                }

                resource command-sender {
                    has-permission: func(server: borrow<server>, permission: string) -> bool;
                }
            }
        `,
    );
    writeWit(
        root,
        'server.wit',
        `
            interface server {
                use player.{player};
                use %world.{%world};
                resource server {
                    constructor();
                    get-mspt: func() -> f64;
                    get-player-count: func() -> u32;
                    get-all-players: func() -> list<player>;
                    get-all-worlds: func() -> list<%world>;
                    get-player-by-name: func(name: string) -> option<player>;
                }
            }
        `,
    );
    writeWit(
        root,
        'player.wit',
        `
            interface player {
                use common.{position};
                use uuid.{uuid};
                use %world.{%world};
                use text.{text-component};

                resource player {
                    get-id: func() -> uuid;
                    get-position: func() -> position;
                    get-world: func() -> %world;
                    as-java: func() -> option<java-player>;
                    send-system-message: func(text: text-component, overlay: bool);
                }

                resource java-player {
                    send-custom-payload: func(channel: string, data: list<u8>);
                }
            }
        `,
    );
    writeWit(
        root,
        'common.wit',
        `
            interface common {
                record block-pos { x: s32, y: s32, z: s32, }
                type position = tuple<f64, f64, f64>;
            }
        `,
    );
    writeWit(
        root,
        'biomes.wit',
        `
            interface biomes {
                enum biome { plains, forest, }
            }
        `,
    );
    writeWit(
        root,
        'game-rules.wit',
        `
            interface game-rules {
                enum game-rule { natural-health-regeneration, }
                variant game-rule-value { int(s32), %bool(bool), }
            }
        `,
    );
    writeWit(
        root,
        'uuid.wit',
        `
            interface uuid {
                record uuid { high: u64, low: u64, }
                to-string: func(id: uuid) -> string;
            }
        `,
    );
    writeWit(
        root,
        'text.wit',
        `
            interface text {
                resource text-component {
                    from-json: static func(json: string) -> result<text-component, string>;
                    encode: func() -> list<u8>;
                }
            }
        `,
    );
    writeWit(
        root,
        'context.wit',
        `
            interface context {
                use event.{event-type, event-priority};
                resource context {
                    register-event: func(handler-id: u32, event-type: event-type, event-priority: event-priority, blocking: bool);
                }
            }
        `,
    );
    writeWit(
        root,
        'permission.wit',
        `
            interface permission {
                variant permission-default { deny, allow, }
                record permission-child { node: string, value: bool, }
                record permission { node: string, default: permission-default, children: list<permission-child>, }
                resource permission-registry {
                    register: func(value: permission);
                }
            }
        `,
    );
    writeWit(
        root,
        'item-stack.wit',
        `
            interface item-stack {
                resource item-stack {
                    get-registry-key: func() -> string;
                }
            }
        `,
    );
    writeWit(
        root,
        'event.wit',
        `
            interface event {
                use common.{position};
                use item-stack.{item-stack};
                enum event-type { server-tick-end-event, }
                enum event-priority { normal, }
                record server-tick-end-event-data { tick: s32, duration-nanos: s64, }
                record player-move-event-data { to-position: position, }
                record player-click-event-data { cursor: option<item-stack>, }
                variant event {
                    server-tick-end-event(server-tick-end-event-data),
                    player-move-event(player-move-event-data),
                    player-click-event(player-click-event-data),
                }
            }
        `,
    );
    writeWit(
        root,
        'ipc.wit',
        `
            interface ipc {
                type plugin-id = string;
                type ipc-message = list<u8>;
                send-ipc-message: func(recipient: plugin-id, message: ipc-message) -> result<result<ipc-message, string>>;
            }
        `,
    );
    return root;
}

function schedulerFixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'static-hermes-wit-scheduler-'));
    directories.push(root);
    writeWit(
        root,
        'plugin.wit',
        `
            package pumpkin:plugin@0.1.0;
            world plugin { import scheduler; }
        `,
    );
    writeWit(
        root,
        'scheduler.wit',
        `
            interface scheduler {
                schedule-delayed-task: func(handler-id: u32, delay-ticks: u64) -> u32;
                cancel-task: func(task-id: u32);
            }
        `,
    );
    return root;
}

function packetListFixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'static-hermes-wit-packet-list-'));
    directories.push(root);
    writeWit(
        root,
        'plugin.wit',
        `
            package pumpkin:plugin@0.1.0;
            world plugin { import java-packets; }
        `,
    );
    writeWit(
        root,
        'java-packets.wit',
        `
            interface java-packets {
                record c-remove-entities { entity-ids: list<s32>, }
                variant clientbound-packet { c-remove-entities(c-remove-entities), }
                resource java-player { send-packet: func(packet: clientbound-packet); }
            }
        `,
    );
    return root;
}

afterEach(() => {
    for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

async function loadFacade(root, interfaceName, name) {
    const { interfaces } = resolveWit(root, { apiMethods: [] }).apiPackage;
    const apiInterface = interfaces.find((value) => value.name === interfaceName);
    const modulePath = path.join(root, `${name}-facade.mjs`);
    fs.writeFileSync(modulePath, emitPumpkinFacade(apiInterface, interfaces));
    return import(pathToFileURL(modulePath).href);
}

function setHost(host) {
    const previousHost = globalThis.__pumpkinHost;
    globalThis.__pumpkinHost = host;
    return () => {
        if (previousHost === undefined) Reflect.deleteProperty(globalThis, '__pumpkinHost');
        else globalThis.__pumpkinHost = previousHost;
    };
}

describe('WIT-derived Pumpkin API facades', () => {
    it('runs generated free-function and resource facades against host adapters', async () => {
        const root = fixture();
        const calls = [];
        const worldHandle = { getDimension: () => 'overworld', drop() {} };
        const commandHandle = {
            drop() {
                calls.push({ kind: 'drop', receiver: this });
            },
        };
        Object.defineProperty(commandHandle, 'then', {
            value(node) {
                calls.push({ kind: 'then', receiver: this, node });
            },
        });
        const nodeHandle = { drop() {} };
        const restoreHost = setHost({
            world: {
                world: { constructor: () => worldHandle },
                lookupAddedByApiUpdate: (name) => `resolved:${name}`,
            },
            command: {
                command: {
                    constructor: (...args) => {
                        calls.push({ kind: 'constructor', args });
                        return commandHandle;
                    },
                },
                commandNode: {
                    literal: (name) => {
                        calls.push({ kind: 'literal', name });
                        return nodeHandle;
                    },
                },
            },
        });

        try {
            const worldFacade = await loadFacade(root, 'world', 'world-runtime');
            const commandFacade = await loadFacade(root, 'command', 'command-runtime');

            expect(worldFacade.lookupAddedByApiUpdate('new-api')).toBe('resolved:new-api');
            expect(new worldFacade.World().getDimension()).toBe('overworld');

            const commandInstance = new commandFacade.Command(['say'], 'Send a message');
            const node = commandFacade.CommandNode.literal('execute');
            commandInstance.then(node);
            commandInstance[Symbol.dispose]();

            expect(calls[0]).toEqual({ kind: 'constructor', args: [['say'], 'Send a message'] });
            expect(calls[1]).toEqual({ kind: 'literal', name: 'execute' });
            expect(calls[2]).toEqual({ kind: 'then', receiver: commandHandle, node: nodeHandle });
            expect(calls[3]).toEqual({ kind: 'drop', receiver: commandHandle });
        } finally {
            restoreHost();
        }
    });

    it('preserves Uint8Array arguments passed to WIT functions', async () => {
        const root = fixture();
        const restoreHost = setHost({
            ipc: { sendIpcMessage: (_recipient, message) => message },
        });

        try {
            const { sendIpcMessage } = await loadFacade(root, 'ipc', 'ipc');
            const message = new Uint8Array([99, 0, 128, 255, 77]).subarray(1, 4);
            const answer = sendIpcMessage('OtherPlugin', message);

            expect(answer).toBeInstanceOf(Uint8Array);
            expect(Array.from(answer)).toEqual([0, 128, 255]);
        } finally {
            restoreHost();
        }
    });

    it('allows only scheduler cancellation while the plugin is unloading', async () => {
        const root = schedulerFixture();
        const canceledTasks = [];
        const restoreHost = setHost({
            scheduler: {
                cancelTask: (taskId) => canceledTasks.push(taskId),
                scheduleDelayedTask: () => 99,
            },
        });
        const previousUnloading = globalThis.__staticHermesPluginUnloading;
        globalThis.__staticHermesPluginUnloading = true;

        try {
            const facade = await loadFacade(root, 'scheduler', 'scheduler-unloading');

            facade.cancelTask(42);

            expect(canceledTasks).toEqual([42]);
            expect(() => facade.scheduleDelayedTask(7, 20n)).toThrow(
                'Pumpkin host calls are unavailable during plugin unload',
            );
        } finally {
            restoreHost();
            if (previousUnloading === undefined) Reflect.deleteProperty(globalThis, '__staticHermesPluginUnloading');
            else globalThis.__staticHermesPluginUnloading = previousUnloading;
        }
    });

    it('wraps an optional resource result so the returned facade can dispose it', async () => {
        const root = fixture();
        let dropped = false;
        const chunkHandle = { getX: () => 12, drop: () => (dropped = true) };
        const worldHandle = { getChunk: () => chunkHandle };
        const restoreHost = setHost({ world: { world: { constructor: () => worldHandle } } });

        try {
            const { Chunk, World } = await loadFacade(root, 'world', 'world-optional-resource');

            const chunk = new World().getChunk(4, 8);

            expect(chunk).toBeInstanceOf(Chunk);
            expect(chunk.getX()).toBe(12);
            chunk[Symbol.dispose]();
            expect(dropped).toBe(true);
        } finally {
            restoreHost();
        }
    });

    it('throws a catchable JavaScript error when using a disposed Pumpkin resource', async () => {
        const root = fixture();
        let valid = true;
        const worldHandle = {
            getDimension: () => 'overworld',
            get __isValid() {
                return valid;
            },
            drop() {
                valid = false;
            },
        };
        const restoreHost = setHost({ world: { world: { constructor: () => worldHandle } } });

        try {
            const { World } = await loadFacade(root, 'world', 'world-disposed-resource');
            const resource = new World();
            resource[Symbol.dispose]();

            expect(() => resource.getDimension()).toThrow('Cannot use a disposed or transferred resource');
        } finally {
            restoreHost();
        }
    });

    it('wraps resources returned through another Pumpkin interface', async () => {
        const root = fixture();
        let valid = true;
        const worldHandle = {
            getDimension: () => 'overworld',
            get __isValid() {
                return valid;
            },
            drop() {
                valid = false;
            },
        };
        const serverHandle = { getAllWorlds: () => [worldHandle], drop() {} };
        const restoreHost = setHost({ server: { server: { constructor: () => serverHandle } } });

        try {
            const { Server } = await loadFacade(root, 'server', 'server-cross-interface-resource');
            const [world] = new Server().getAllWorlds();
            world[Symbol.dispose]();

            expect(() => world.getDimension()).toThrow('Cannot use a disposed or transferred resource');
        } finally {
            restoreHost();
        }
    });

    it('tracks disposal of foreign resources without a host validity flag', async () => {
        const root = fixture();
        let drops = 0;
        const worldHandle = {
            getDimension: () => 'overworld',
            drop() {
                drops++;
            },
        };
        const serverHandle = { getAllWorlds: () => [worldHandle], drop() {} };
        const restoreHost = setHost({ server: { server: { constructor: () => serverHandle } } });

        try {
            const { Server } = await loadFacade(root, 'server', 'server-foreign-resource');
            const [world] = new Server().getAllWorlds();

            expect(world.getDimension()).toBe('overworld');
            world[Symbol.dispose]();
            world[Symbol.dispose]();

            expect(drops).toBe(1);
            expect(() => world.getDimension()).toThrow('Cannot use a disposed or transferred resource');
        } finally {
            restoreHost();
        }
    });

    it('wraps every resource in a WIT resource list', async () => {
        const root = fixture();
        const chunkHandles = [
            { getX: () => 3, drop() {} },
            { getX: () => 9, drop() {} },
        ];
        const worldHandle = { getChunks: () => chunkHandles };
        const restoreHost = setHost({ world: { world: { constructor: () => worldHandle } } });

        try {
            const { Chunk, World } = await loadFacade(root, 'world', 'world-resource-list');

            const chunks = new World().getChunks();

            expect(chunks).toHaveLength(2);
            expect(chunks.every((chunk) => chunk instanceof Chunk)).toBe(true);
            expect(chunks.map((chunk) => chunk.getX())).toEqual([3, 9]);
        } finally {
            restoreHost();
        }
    });

    it('does not add an interface absent from the plugin world', () => {
        const root = fixture();
        writeWit(root, 'unused.wit', 'interface unused { ping: func(); }');
        const { apiPackage: api } = resolveWit(root, { apiMethods: [] });

        expect(api.packageName).toBe('pumpkin:plugin');
        expect(api.version).toBe('0.1.0');
        expect(api.interfaces.map((value) => value.name)).toEqual([
            'world',
            'common',
            'biomes',
            'game-rules',
            'command',
            'uuid',
            'server',
            'player',
            'text',
            'context',
            'event',
            'item-stack',
            'permission',
            'ipc',
        ]);

        const world = api.interfaces.find((value) => value.name === 'world');
        expect(world.dependencies).toEqual(['common', 'biomes', 'game-rules']);
        const worldResource = world.resources.find((resource) => resource.name === 'world');
        expect(worldResource.functions.find((operation) => operation.name === 'get-chunk')).toMatchObject({
            isStatic: false,
            features: [],
            parameters: [
                { name: 'x', type: 's32' },
                { name: 'z', type: 's32' },
            ],
            result: 'option<chunk>',
        });
    });

    it('converts tuple aliases in event records to JavaScript arrays', () => {
        const dispatch = eventDispatch(fixture());

        expect(dispatch).toContain('Array eventValueToPosition(runtime, 3);');
        expect(dispatch).toContain(
            'eventValueToPosition.setValueAtIndex(runtime, 0, Value(eventData.to_position.f0));',
        );
        expect(dispatch).toContain(
            'eventValueToPosition.setValueAtIndex(runtime, 1, Value(eventData.to_position.f1));',
        );
        expect(dispatch).toContain(
            'eventValueToPosition.setValueAtIndex(runtime, 2, Value(eventData.to_position.f2));',
        );
        expect(dispatch).toContain('data.setProperty(runtime, "toPosition", std::move(eventValueToPosition));');
    });

    it('wraps event resources with the generic Pumpkin WIT resource adapter', () => {
        const dispatch = eventDispatch(fixture());

        expect(dispatch).toContain('ResourceState{eventData.cursor.val.__handle, true, "item-stack", "item-stack"}');
        expect(dispatch).toContain('wrapResourceObject(runtime, makeWitResourceObject(eventValueCursorValueState))');
    });

    it('generates only requested interface functions with nested result and byte-list conversions', () => {
        const root = fixture();
        const dispatch = methodDispatch(root, ['ipc.send-ipc-message']);
        const unused = methodDispatch(root, []);

        expect(dispatch).toContain('pumpkin_plugin_ipc_send_ipc_message');
        expect(dispatch).toContain('wasiInputString(rt, args[0])');
        expect(dispatch).toContain('asUint8Array(rt)');
        expect(dispatch).toContain('result.is_err');
        expect(dispatch).toContain('Uint8Array');
        expect(dispatch).toContain('if (!callSucceeded) { Object errorValue(rt);');
        expect(dispatch).not.toContain('pumpkin_plugin_world_lookup_added_by_api_update');
        expect(unused).not.toContain('pumpkin_plugin_ipc_send_ipc_message');
    });

    it('generates adapters for optional scalar results with tuple-list arguments', () => {
        const dispatch = methodDispatch(fixture(), ['world.resolve-block-state']);

        expect(dispatch).toContain('pumpkin_plugin_world_resolve_block_state');
        expect(dispatch).toContain('const bool hasResult = pumpkin_plugin_world_resolve_block_state');
        expect(dispatch).toContain('if (!hasResult) return Value::null();');
        expect(dispatch).toContain('auto converted = Value(static_cast<double>(result));');
    });

    it('accepts and returns typed arrays for primitive WIT lists', () => {
        const root = fixture();
        const inputDispatch = methodDispatch(root, ['world.world.accept-entity-ids']);
        const resultDispatch = methodDispatch(root, ['world.world.get-entity-ids']);

        expect(inputDispatch).toContain('isTypedArray(rt)');
        expect(inputDispatch).toContain('std::to_string(argument0Index).c_str()');
        expect(resultDispatch).toContain('getPropertyAsFunction(rt, "Int32Array")');
        expect(resultDispatch).toContain('std::to_string(index).c_str()');
    });

    it('accepts a typed array nested inside a packet variant record', () => {
        const dispatch = methodDispatch(packetListFixture(), ['java-packets.java-player.send-packet']);

        expect(dispatch).toContain('argument0CRemoveEntitiesEntityIdsArray.isTypedArray(rt)');
        expect(dispatch).toContain(
            'argument0CRemoveEntitiesEntityIdsArray.getProperty(rt, std::to_string(argument0CRemoveEntitiesEntityIdsIndex).c_str())',
        );
        expect(dispatch).not.toContain('argument0CRemoveEntitiesEntityIdsArray.asArray(rt)');
    });

    it('generates selected static resource functions as WIT-derived host methods', () => {
        const dispatch = methodDispatch(fixture(), ['text.text-component.from-json']);

        expect(dispatch).toContain('pumpkin_plugin_text_static_text_component_from_json');
        expect(dispatch).toContain('generatedTextTextComponentApi.setProperty');
        expect(dispatch).toContain('"fromJson"');
        expect(dispatch).toContain('generatedTextApi.setProperty(runtime, "textComponent"');
        expect(dispatch).toContain('host.getProperty(runtime, "text")');
        expect(dispatch).toContain('generatedTextTextComponentApiValue.isObject()');
        expect(dispatch).toContain('return wrapResourceObject(rt, makeWitResourceObject(resourceState));');
        expect(dispatch).toContain('pumpkin_plugin_text_text_component_drop_own');
    });

    it('generates constructors only for the selected Pumpkin resources', () => {
        const dispatch = methodDispatch(fixture(), ['command.command.constructor']);

        expect(dispatch).toContain('pumpkin_plugin_command_constructor_command');
        expect(dispatch).toContain('generatedCommandCommandApi.setProperty');
        expect(dispatch).toContain('"constructor"');
        expect(dispatch).not.toContain('pumpkin_plugin_command_method_command_constructor');
        expect(dispatch).not.toContain('pumpkin_plugin_world_constructor_world');
    });

    it('converts WIT chars to and from single-character JavaScript strings', () => {
        const root = fixture();
        const textPath = path.join(root, 'text.wit');
        const source = fs.readFileSync(textPath, 'utf8');
        fs.writeFileSync(
            textPath,
            source.replace(
                'encode: func() -> list<u8>;',
                'encode: func() -> list<u8>;\nround-trip-char: static func(value: char) -> char;',
            ),
        );

        const dispatch = methodDispatch(root, ['text.text-component.round-trip-char']);

        expect(dispatch).toContain(
            'pumpkin_plugin_text_static_text_component_round_trip_char(wasiInputChar(rt, args[0]))',
        );
        expect(dispatch).toContain('return jsString(rt, wasiOutputChar(rt, static_cast<uint32_t>(result)));');
    });

    it('generates native scalar resource methods from WIT declarations', () => {
        const dispatch = methodDispatch(fixture());

        expect(dispatch).toContain('pumpkin_plugin_server_method_server_get_mspt');
        expect(dispatch).toContain('pumpkin_plugin_server_method_server_get_player_count');
        expect(dispatch).toContain('"getMspt"');
        expect(dispatch).toContain('"getPlayerCount"');
    });

    it('wraps generated Pumpkin resource results in native resource objects', () => {
        const dispatch = methodDispatch(fixture(), ['server.server.get-all-worlds']);

        expect(dispatch).toContain('wrapResourceObject(rt, makeWitResourceObject(');
    });

    it('resolves aliased packet types from another Pumpkin WIT interface', () => {
        const root = fixture();
        writeWit(
            root,
            'player.wit',
            `
                interface player {
                    use java-packets.{clientbound-packet as java-packet};
                    use bedrock-packets.{clientbound-packet as bedrock-packet};
                    resource player;
                    resource java-player {
                        send-packet: func(packet: java-packet);
                    }
                }
            `,
        );
        writeWit(
            root,
            'java-packets.wit',
            `
                interface java-packets {
                    record action-packet { action-id: string, data: list<u8>, }
                    variant clientbound-packet { c-spawn-entity(action-packet), no-op, }
                }
            `,
        );
        writeWit(
            root,
            'bedrock-packets.wit',
            `
                interface bedrock-packets {
                    record other-packet { value: u32, }
                    variant clientbound-packet { other(other-packet), }
                }
            `,
        );
        const dispatch = methodDispatch(root, ['player.java-player.send-packet']);

        expect(dispatch).toContain('pumpkin_plugin_player_method_java_player_send_packet');
        expect(dispatch).toContain('pumpkin_plugin_java_packets_clientbound_packet_t argument0{};');
        expect(dispatch).toContain('argument0Tag == "c-spawn-entity"');
        expect(dispatch).not.toContain('argument0Tag == "cSpawnEntity"');
        expect(dispatch).toContain('argument0CSpawnEntity');
        expect(dispatch).not.toContain('PUMPKIN_PLUGIN_BEDROCK_PACKETS_CLIENTBOUND_PACKET_OTHER');
    });

    it('generates event registration adapters from their WIT enum definitions', () => {
        const dispatch = methodDispatch(fixture(), ['context.context.register-event']);

        expect(dispatch).toContain('pumpkin_plugin_context_method_context_register_event');
        expect(dispatch).toContain('PUMPKIN_PLUGIN_EVENT_EVENT_TYPE_SERVER_TICK_END_EVENT');
        expect(dispatch).toContain('PUMPKIN_PLUGIN_EVENT_EVENT_PRIORITY_NORMAL');
    });

    it('generates string-returning resource methods with owned WIT string cleanup', () => {
        const dispatch = methodDispatch(fixture());

        expect(dispatch).toContain('"getDimension"');
        expect(dispatch).toContain('pumpkin_plugin_world_method_world_get_dimension');
        expect(dispatch).toContain('plugin_string_t result{};');
        expect(dispatch).toContain('plugin_string_free(&result);');
        expect(dispatch).toContain('const auto text = wasiStringValue(result);');
        expect(dispatch).toContain('return jsString(rt, text);');
    });

    it('generates tuple and resource return adapters only for the selected methods', () => {
        const dispatch = methodDispatch(fixture(), [
            'player.player.get-position',
            'player.player.get-world',
            'player.player.get-id',
            'player.player.as-java',
            'player.player.send-system-message',
            'command.command-sender.has-permission',
            'world.world.get-world-border',
            'world.world-border.get-center-x',
            'world.world-border.get-center-z',
            'world.world-border.get-size',
            'server.server.get-all-players',
            'server.server.get-player-by-name',
            'world.world.get-block-state-id',
            'world.world.get-biome',
            'world.world.get-game-rule',
            'world.world.get-chunk',
            'player.java-player.send-custom-payload',
        ]);

        expect(dispatch).toContain('pumpkin_plugin_player_method_player_get_position');
        expect(dispatch).toContain('result.f0');
        expect(dispatch).toContain('result.f1');
        expect(dispatch).toContain('result.f2');
        expect(dispatch).toContain('pumpkin_plugin_player_method_player_get_world');
        expect(dispatch).toContain('pumpkin_plugin_world_method_world_get_world_border');
        expect(dispatch).toContain('pumpkin_plugin_world_method_world_border_get_center_x');
        expect(dispatch).toContain('pumpkin_plugin_world_method_world_border_get_center_z');
        expect(dispatch).toContain('pumpkin_plugin_world_method_world_border_get_size');
        expect(dispatch).toContain('pumpkin_plugin_world_method_world_get_block_state_id');
        expect(dispatch).toContain('pumpkin_plugin_world_method_world_get_biome');
        expect(dispatch).toContain('pumpkin_plugin_world_method_world_get_game_rule');
        expect(dispatch).toContain('pumpkin_plugin_world_method_world_get_chunk');
        expect(dispatch).toContain('pumpkin_plugin_server_method_server_get_all_players');
        expect(dispatch).toContain('pumpkin_plugin_server_method_server_get_player_by_name');
        expect(dispatch).toContain('pumpkin_plugin_player_method_java_player_send_custom_payload');
        expect(dispatch).toContain('pumpkin_plugin_player_method_player_get_id');
        expect(dispatch).toContain('pumpkin_plugin_player_method_player_send_system_message');
        expect(dispatch).toMatch(/getWitResourceState\(rt, args\[0\], "text", "text-component"/);
        expect(dispatch).toMatch(/own_text_component_t argument0\{argument0State->handle\};/);
        expect(dispatch).toContain('argument0State->transfer();');
        expect(dispatch).toContain('pumpkin_plugin_command_method_command_sender_has_permission');
        expect(dispatch).toMatch(/getWitResourceState\(rt, args\[0\], "server", "server"/);
        expect(dispatch).toContain('pumpkin_plugin_server_borrow_server_t argument0{argument0State->handle};');
        expect(dispatch).not.toContain('getPlayerCount');
    });

    it('generates adapters only for the selected methods', () => {
        const dispatch = methodDispatch(fixture(), ['server.server.get-mspt']);

        expect(dispatch).toContain('getMspt');
        expect(dispatch).not.toContain('getPlayerCount');
        expect(dispatch).not.toContain('getCenterX');
    });

    it('converts enum fields in returned records to their WIT names', () => {
        const dispatch = methodDispatch(fixture(), ['world.get-block-state']);

        expect(dispatch).toContain('case PUMPKIN_PLUGIN_WORLD_PISTON_BEHAVIOR_NORMAL');
        expect(dispatch).toContain('jsString(rt, "normal")');
        expect(dispatch).toContain('String resultValuePistonBehavior = jsString(rt, "normal");');
        expect(dispatch).not.toContain('jsString(rt, result.piston_behavior)');
        expect(dispatch.indexOf('pumpkin_plugin_world_get_block_state(&result);')).toBeLessThan(
            dispatch.indexOf('switch (result.piston_behavior)'),
        );
    });

    it('uses WIT C signatures and frees only allocated result values', () => {
        const dispatch = methodDispatch(fixture(), [
            'server.server.get-all-players',
            'server.server.get-player-by-name',
            'uuid.to-string',
            'world.world.get-block-state-id',
        ]);

        expect(dispatch).toContain('pumpkin_plugin_server_list_own_player_free(&result);');
        expect(dispatch).not.toContain('pumpkin_plugin_list_own_player_free');
        expect(dispatch).toMatch(/pumpkin_plugin_server_method_server_get_player_by_name\([^;]+&argument0, &result\)/);
        expect(dispatch).not.toContain('pumpkin_plugin_uuid_uuid_free');
        expect(dispatch).not.toContain('pumpkin_plugin_common_block_pos_free');
    });

    it('escapes C++ keywords in generated WIT record member access', () => {
        const dispatch = methodDispatch(fixture(), ['permission.permission-registry.register']);

        expect(dispatch).toContain('argument0.default_ = argument0Default;');
    });

    it('uses the declaring interface namespace for lists of named Pumpkin WIT records', () => {
        const dispatch = methodDispatch(fixture(), ['permission.permission-registry.register']);

        expect(dispatch).toContain('pumpkin_plugin_permission_list_permission_child_t argument0Children');
    });
});

describe('WASI adapter planning', () => {
    it('enables WIT features only for selected gated operations', () => {
        const root = wasiSocketFixture();
        const imports = ['wasi:sockets/instance-network@0.2.3'];

        expect(wasiDispatch(root, imports, []).analysis.wasiFeatures).toEqual([]);
        expect(
            wasiDispatch(root, imports, ['wasi:sockets/network@0.2.3#network-error-code']).analysis.wasiFeatures,
        ).toEqual(['network-error-code']);
    });

    it('plans every resource constructor and static function', () => {
        const root = wasiResourceOperationsFixture();
        const imports = ['wasi:test/runtime@0.2.3'];
        const operationIds = [
            'wasi:test/runtime@0.2.3#handle.constructor',
            'wasi:test/runtime@0.2.3#handle.value',
            'wasi:test/runtime@0.2.3#handle.create',
            'wasi:test/runtime@0.2.3#handle.release',
        ];

        expect(wasiDispatch(root, imports).plan).toEqual(operationIds);
        const { plan, dispatch } = wasiDispatch(root, imports, operationIds);
        expect(plan).toEqual(operationIds);
        expect(dispatch).toContain('wasi_test_runtime_constructor_handle');
        expect(dispatch).toContain('wasi_test_runtime_static_handle_create');
        expect(dispatch).toContain('wasi_test_runtime_static_handle_release');
    });

    it('exposes WASI resource constructors and static functions through the generated facade', async () => {
        const root = wasiResourceOperationsFixture();
        const { analysis } = wasiDispatch(root, ['wasi:test/runtime@0.2.3']);
        const apiInterface = analysis.resolvedWasiInterfaces.find((value) => value.name === 'runtime');
        const modulePath = path.join(root, 'runtime-facade.mjs');
        fs.writeFileSync(modulePath, emitWasiFacade(apiInterface));
        const previousApi = globalThis.__pumpkinWasiTestRuntime;
        globalThis.__pumpkinWasiTestRuntime = {
            handle: {
                constructor: (value) => ({ value: () => value, drop() {} }),
                create: (value) => ({ value: () => value + 1, drop() {} }),
                release: (handle) => handle.value(),
            },
        };

        try {
            const { Handle } = await import(pathToFileURL(modulePath).href);

            expect(new Handle(7).value()).toBe(7);
            expect(Handle.create(9).value()).toBe(10);
            expect(Handle.release(new Handle(12))).toBe(12);
        } finally {
            if (previousApi === undefined) Reflect.deleteProperty(globalThis, '__pumpkinWasiTestRuntime');
            else globalThis.__pumpkinWasiTestRuntime = previousApi;
        }
    });

    it('plans only the functions and resource methods used by the plugin', () => {
        const usedMethods = [
            'wasi:sockets/instance-network@0.2.3#instance-network',
            'wasi:sockets/network@0.2.3#network.get-network-id',
        ];

        const { plan, dispatch } = wasiDispatch(
            wasiSocketFixture(),
            ['wasi:sockets/instance-network@0.2.3'],
            usedMethods,
        );

        expect(plan).toEqual(usedMethods);
        expect(dispatch).toContain('wasi_sockets_network_network_drop_own');
        expect(dispatch).not.toContain('wasi_sockets_network_unused_drop_own');
    });

    it('rejects a used operation that is absent from the imported WIT interfaces', () => {
        expect(() =>
            wasiDispatch(
                wasiSocketFixture(),
                ['wasi:sockets/instance-network@0.2.3'],
                ['wasi:sockets/network@0.2.3#missing-operation'],
            ),
        ).toThrow(
            /WASI operation used by the plugin is not declared in WIT: wasi:sockets\/network@0\.2\.3#missing-operation/,
        );
    });

    it('plans WASI operations whose result contains tuples and byte lists', () => {
        const root = wasiFilesystemFixture();
        const imports = ['wasi:filesystem/types@0.2.3', 'wasi:http/types@0.2.3'];
        const usedMethods = ['wasi:filesystem/types@0.2.3#descriptor.read'];

        expect(wasiDispatch(root, imports).plan).toEqual([
            'wasi:filesystem/types@0.2.3#descriptor.read',
            'wasi:filesystem/types@0.2.3#descriptor.stat-at',
        ]);
        expect(wasiDispatch(root, imports, usedMethods).plan).toEqual(usedMethods);
    });

    it('plans preopen results that pair resource handles with paths', () => {
        const usedMethods = ['wasi:filesystem/preopens@0.2.3#get-directories'];

        expect(
            wasiDispatch(wasiFilesystemPreopensFixture(), ['wasi:filesystem/preopens@0.2.3'], usedMethods).plan,
        ).toEqual(usedMethods);
    });

    it('resolves nested records from a different WASI package', () => {
        const usedMethods = ['wasi:filesystem/types@0.2.3#descriptor.stat-at'];

        const { plan, dispatch } = wasiDispatch(
            wasiFilesystemFixture(),
            ['wasi:filesystem/types@0.2.3', 'wasi:http/types@0.2.3'],
            usedMethods,
        );

        expect(plan).toEqual(usedMethods);
        expect(dispatch).toContain('WASI_FILESYSTEM_TYPES_PATH_FLAGS_SYMLINK_FOLLOW');
        expect(dispatch).toContain('dataModificationTimestamp');
        expect(dispatch).toContain('result.data_modification_timestamp.val.seconds');
    });

    it('plans stream and pollable operations from their WIT declarations', () => {
        const usedMethods = [
            'wasi:http/types@0.2.3#fields.set',
            'wasi:http/types@0.2.3#outgoing-request.set-method',
            'wasi:http/types@0.2.3#outgoing-request.set-path-with-query',
            'wasi:http/types@0.2.3#outgoing-request.set-scheme',
            'wasi:http/types@0.2.3#request-options.set-connect-timeout',
            'wasi:io/streams@0.2.3#input-stream.read',
            'wasi:io/streams@0.2.3#input-stream.subscribe',
            'wasi:io/poll@0.2.3#pollable.ready',
            'wasi:io/poll@0.2.3#pollable.block',
        ];

        const { plan, dispatch } = wasiDispatch(
            wasiHttpStreamFixture(),
            ['wasi:http/types@0.2.3', 'wasi:io/streams@0.2.3'],
            usedMethods,
        );

        expect(plan).toEqual(usedMethods);
        expect(dispatch).toContain('WASI_HTTP_TYPES_METHOD_OTHER');
        expect(dispatch).toContain('argument0.val.other');
        expect(dispatch).toContain('callSucceeded');
        expect(dispatch).toContain('wasi_http_types_list_field_value_t argument0');
        expect(dispatch).toContain('plugin_string_t argument0Storage{};');
        expect(dispatch).toContain('plugin_string_t *argument0 = nullptr;');
        expect(dispatch).toContain('wasi_http_types_scheme_t argument0Storage{};');
        expect(dispatch).toContain('uint64_t argument0Storage{};');
        expect(dispatch).toContain('if (!args[0].isNull() && !args[0].isUndefined())');
        expect(dispatch).not.toContain('wasi_http_types_option_string_t');
    });

    it('uses bindgen C names for resource aliases, borrowed-resource lists, and acronym types', () => {
        const usedMethods = [
            'wasi:http/types@0.2.3#echo-trailers',
            'wasi:http/types@0.2.3#accept-payload',
            'wasi:http/types@0.2.3#get-payload',
            'wasi:http/types@0.2.3#future-trailers.get',
            'wasi:io/poll@0.2.3#poll',
        ];

        const { dispatch } = wasiDispatch(
            wasiHttpStreamFixture(),
            ['wasi:http/types@0.2.3', 'wasi:io/poll@0.2.3'],
            usedMethods,
        );

        expect(dispatch).toContain('wasi_http_types_own_trailers_t argument0');
        expect(dispatch).toContain('wasi_http_types_own_trailers_t result{};');
        expect(dispatch).toContain('wasi_http_types_result_result_option_own_trailers_error_code_void_t result{};');
        expect(dispatch).toContain('wasi_io_poll_list_borrow_pollable_t argument0');
        expect(dispatch).toContain('wasi_http_types_dns_error_payload_t argument0DNSError{};');
        expect(dispatch).toContain('wasi_http_types_tls_alert_received_payload_t argument0TLSAlertReceived{};');
        expect(dispatch).not.toContain('wasi_http_types_trailers_free');
        expect(dispatch).not.toContain('wasi_io_poll_list_borrow_own_pollable_t');
        expect(dispatch).not.toContain('wasi_http_types_DNS_error_payload_t');
        expect(dispatch).not.toContain('wasi_http_types_TLS_alert_received_payload_t');
    });

    it('plans and converts TCP socket addresses and UDP datagram records', () => {
        const root = wasiSocketAddressFixture();
        const imports = ['wasi:sockets/tcp@0.2.3', 'wasi:sockets/udp@0.2.3'];
        const usedMethods = [
            'wasi:sockets/tcp@0.2.3#tcp-socket.start-bind',
            'wasi:sockets/tcp@0.2.3#tcp-socket.start-connect',
            'wasi:sockets/tcp@0.2.3#tcp-socket.finish-connect',
            'wasi:sockets/tcp@0.2.3#tcp-socket.accept',
            'wasi:sockets/udp@0.2.3#udp-socket.start-bind',
            'wasi:sockets/udp@0.2.3#udp-socket.stream',
            'wasi:sockets/udp@0.2.3#incoming-datagram-stream.receive',
            'wasi:sockets/udp@0.2.3#outgoing-datagram-stream.send',
        ];

        expect(wasiDispatch(root, imports).plan).toEqual(usedMethods);
        const { plan, dispatch } = wasiDispatch(root, imports, usedMethods);
        expect(plan).toEqual(usedMethods);
        expect(dispatch).toContain('wasi_sockets_network_borrow_network_t argument0');
        expect(dispatch).toContain('WASI_SOCKETS_NETWORK_IP_SOCKET_ADDRESS_IPV4');
        expect(dispatch).toContain('static_cast<wasi_sockets_udp_outgoing_datagram_t *>');
        expect(dispatch).toContain('wasi_sockets_udp_list_outgoing_datagram_t');
        expect(dispatch).toContain('std::memcpy');
        expect(dispatch).toContain('const bool callSucceeded = wasi_sockets_udp_method_outgoing_datagram_stream_send');
        expect(dispatch).toContain('wasi_sockets_network_error_code_t error{};');
    });

    it('resolves a renamed resource from a WASI dependency in an unused operation', () => {
        const root = wasiHttpStreamFixture();
        const imports = ['wasi:http/types@0.2.3'];
        const operationId = 'wasi:http/types@0.2.3#http-error-code';

        expect(wasiDispatch(root, imports).plan).toContain(operationId);
        const { dispatch } = wasiDispatch(root, imports, [operationId]);
        expect(dispatch).toContain('getWitResourceState(rt, args[0], "error", "error", "wasi:io")');
        expect(dispatch.indexOf('const bool hasResult = wasi_http_types_http_error_code')).toBeLessThan(
            dispatch.indexOf('switch (result)'),
        );
    });
});
