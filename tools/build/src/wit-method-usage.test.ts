import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { afterEach, describe, expect, it } from 'vitest';
import { BuildError } from './errors.ts';
import { findUsedWitMethods, type UsedWitMethods } from './wit-method-usage.ts';

const directories: string[] = [];

function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pumpkin-wit-method-usage-'));
    directories.push(root);
    const interfaces = path.join(root, 'build/types/bindings/interfaces');
    fs.mkdirSync(interfaces, { recursive: true });
    fs.writeFileSync(
        path.join(root, 'tsconfig.json'),
        JSON.stringify({
            compilerOptions: {
                target: 'ES2022',
                module: 'ESNext',
                moduleResolution: 'Bundler',
                strict: true,
                types: [],
            },
            include: ['entry.ts', 'build/types/**/*.d.ts'],
        }),
    );
    fs.writeFileSync(
        path.join(interfaces, 'pumpkin-plugin-player.d.ts'),
        'import type { World } from "./pumpkin-plugin-world";\nexport class Player { getPosition(): [number, number, number]; getWorld(): World; asJava(): JavaPlayer | undefined; }\nexport class JavaPlayer { sendCustomPayload(channel: string, data: Uint8Array): void; }\n',
    );
    fs.writeFileSync(path.join(interfaces, 'pumpkin-plugin-world.d.ts'), 'export class World { getName(): string; }\n');
    fs.writeFileSync(
        path.join(interfaces, 'pumpkin-plugin-context.d.ts'),
        'export type EventType = "tick"; export type EventPriority = "normal"; export class Context { registerEvent(id: number, type: EventType, priority: EventPriority, blocking: boolean): void; }\n',
    );
    fs.writeFileSync(
        path.join(interfaces, 'pumpkin-plugin-command.d.ts'),
        'export class Command { constructor(names: Array<string>, description: string); executeWithHandlerId(id: number): void; }\n',
    );
    fs.writeFileSync(
        path.join(interfaces, 'pumpkin-plugin-text.d.ts'),
        'export class TextComponent { static fromJson(json: string): TextComponent; encode(): Uint8Array; }\n',
    );
    fs.writeFileSync(
        path.join(interfaces, 'pumpkin-plugin-ipc.d.ts'),
        'export type Result<T, E> = { tag: "ok"; val: T } | { tag: "err"; val: E }; export function sendIpcMessage(recipient: string, message: Uint8Array): Result<Uint8Array, string>;\n',
    );
    fs.writeFileSync(
        path.join(interfaces, 'wasi-sockets-instance-network.d.ts'),
        'declare module "wasi:sockets/instance-network@0.2.3" { export function instanceNetwork(): Network; export class Network { private constructor(); } }\n',
    );
    fs.writeFileSync(
        path.join(interfaces, 'wasi-sockets-tcp.d.ts'),
        'declare module "wasi:sockets/tcp@0.2.3" { export class TcpSocket { private constructor(); startConnect(network: import("wasi:sockets/instance-network@0.2.3").Network): void; localAddress(): string; } }\n',
    );
    const dependency = path.join(root, 'node_modules/pumpkin-api/dist');
    fs.mkdirSync(dependency, { recursive: true });
    fs.writeFileSync(
        path.join(dependency, 'index.ts'),
        'import type { Context } from "../../../build/types/bindings/interfaces/pumpkin-plugin-context"; import { sendIpcMessage as sendIpc } from "../../../build/types/bindings/interfaces/pumpkin-plugin-ipc"; export function installEvents(ctx: Context) { ctx.registerEvent(1, "tick", "normal", true); sendIpc("PumpkinPIE", new Uint8Array()); }\n',
    );
    fs.writeFileSync(
        path.join(root, 'entry.ts'),
        'import { Command } from "./build/types/bindings/interfaces/pumpkin-plugin-command"; import { JavaPlayer, Player } from "./build/types/bindings/interfaces/pumpkin-plugin-player"; import { TextComponent } from "./build/types/bindings/interfaces/pumpkin-plugin-text"; import { World } from "./build/types/bindings/interfaces/pumpkin-plugin-world"; import { installEvents } from "./node_modules/pumpkin-api/dist/index"; import { instanceNetwork } from "wasi:sockets/instance-network@0.2.3"; import { TcpSocket } from "wasi:sockets/tcp@0.2.3";\ndeclare const player: Player; declare const world: World; declare const java: JavaPlayer; declare const socket: TcpSocket;\nnew Command(["say"], "Send a message"); player.getPosition(); player.asJava(); world.getName(); java.sendCustomPayload("x", new Uint8Array()); TextComponent.fromJson("{}").encode(); installEvents({} as never); instanceNetwork(); socket.startConnect(instanceNetwork());\nclass Local { getPosition() {} } new Local().getPosition();\n',
    );
    return path.join(root, 'entry.ts');
}

function isolatedWasiFixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pumpkin-wit-method-isolated-'));
    directories.push(root);
    const generatedTypes = path.join(root, 'temporary-wit-types');
    fs.mkdirSync(generatedTypes);
    fs.writeFileSync(
        path.join(root, 'tsconfig.json'),
        JSON.stringify({
            compilerOptions: {
                target: 'ES2022',
                module: 'ESNext',
                moduleResolution: 'Bundler',
                strict: true,
                types: [],
            },
            include: ['entry.ts'],
        }),
    );
    fs.writeFileSync(
        path.join(generatedTypes, 'wasi-sockets-tcp.d.ts'),
        'declare module "wasi:sockets/tcp@0.2.3" { export class TcpSocket { constructor(); startConnect(): void; } }\n',
    );
    const entry = path.join(root, 'entry.ts');
    fs.writeFileSync(
        entry,
        'import { TcpSocket } from "wasi:sockets/tcp@0.2.3"; const socket = new TcpSocket(); socket.startConnect();\n',
    );
    return { entry, generatedTypes };
}

function pluginKitFixture(): { entry: string; generatedTypes: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pumpkin-plugin-kit-wit-types-'));
    directories.push(root);
    const pluginKitRoot = fileURLToPath(new URL('../../plugin-kit', import.meta.url));
    const sourceDirectory = path.join(root, 'src');
    fs.cpSync(path.join(pluginKitRoot, 'src'), sourceDirectory, { recursive: true });
    const docsPackage = path.join(root, 'node_modules/@pumpkin-plugins/docs');
    fs.mkdirSync(path.dirname(docsPackage), { recursive: true });
    fs.symlinkSync(
        path.resolve(pluginKitRoot, '../docs'),
        docsPackage,
        process.platform === 'win32' ? 'junction' : 'dir',
    );
    fs.writeFileSync(
        path.join(root, 'tsconfig.json'),
        JSON.stringify({
            compilerOptions: {
                target: 'ES2022',
                module: 'ESNext',
                moduleResolution: 'Bundler',
                strict: true,
                types: [],
            },
            include: ['src/register-commands.ts'],
        }),
    );
    const generatedTypes = path.join(root, 'types');
    const interfaces = path.join(generatedTypes, 'interfaces');
    fs.mkdirSync(interfaces, { recursive: true });
    const declarations: Record<string, string> = {
        'pumpkin-plugin-command.d.ts': `declare module 'pumpkin:plugin/command@0.1.0' {
            export type Arg = { tag: 'simple'; val: string } | { tag: 'players'; val: import('pumpkin:plugin/player@0.1.0').Player[] } | { tag: 'num'; val: { tag: 'ok'; val: { tag: 'int32' | 'float64'; val: number } } } | { tag: 'item'; val: string };
            export interface ConsumedArgs { getValue(name: string): Arg; }
            export interface SuggestionRequest { input: string; cursor: number; start: number; remaining: string; }
            export interface CommandSuggestions { start: number; length: number; values: Array<{ value: string; tooltip?: import('pumpkin:plugin/text@0.1.0').TextComponent }>; }
            export interface CommandSender { sendMessage(text: import('pumpkin:plugin/text@0.1.0').TextComponent): void; hasPermission(server: import('pumpkin:plugin/server@0.1.0').Server, node: string): boolean; }
            export class Command { constructor(names: string[], description: string); then(node: CommandNode): void; executeWithHandlerId(handlerId: number): void; }
            export class CommandNode { private constructor(); static literal(name: string): CommandNode; static argument(name: string, type: unknown): CommandNode; then(node: CommandNode): void; executeWithHandlerId(handlerId: number): void; suggestWithHandlerId(handlerId: number): void; }
        }`,
        'pumpkin-plugin-context.d.ts': `declare module 'pumpkin:plugin/context@0.1.0' {
            export interface Context { getServer(): import('pumpkin:plugin/server@0.1.0').Server; registerCommand(command: import('pumpkin:plugin/command@0.1.0').Command, permission: string): void; registerPermission(permission: import('pumpkin:plugin/permission@0.1.0').Permission): void; }
        }`,
        'pumpkin-plugin-permission.d.ts': `declare module 'pumpkin:plugin/permission@0.1.0' {
            export type PermissionDefault = { tag: 'allow' } | { tag: 'deny' } | { tag: 'op'; val: 'zero' | 'one' | 'two' | 'three' | 'four' };
            export interface Permission { node: string; description: string; default: PermissionDefault; children: Array<{ node: string; value: boolean }>; }
        }`,
        'pumpkin-plugin-server.d.ts': `declare module 'pumpkin:plugin/server@0.1.0' { export interface Server {} }`,
        'pumpkin-plugin-text.d.ts': `declare module 'pumpkin:plugin/text@0.1.0' {
            export class TextComponent { static fromLegacyString(input: string): TextComponent; colorNamed(color: string): void; }
        }`,
        'pumpkin-plugin-player.d.ts': `declare module 'pumpkin:plugin/player@0.1.0' {
            export class Player { getId(): import('pumpkin:plugin/uuid@0.1.0').Uuid; getName(): string; }
        }`,
        'pumpkin-plugin-uuid.d.ts': `declare module 'pumpkin:plugin/uuid@0.1.0' {
            export interface Uuid { high: bigint; low: bigint; }
            export function toString(id: Uuid): string;
        }`,
        'pumpkin-plugin-logging.d.ts': `declare module 'pumpkin:plugin/logging@0.1.0' { export function log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void; }`,
        'pumpkin-plugin-scheduler.d.ts': `declare module 'pumpkin:plugin/scheduler@0.1.0' {
            export function scheduleDelayedTask(handlerId: number, delayTicks: bigint): number;
            export function scheduleRepeatingTask(handlerId: number, delayTicks: bigint, periodTicks: bigint): number;
            export function cancelTask(taskId: number): void;
        }`,
    };
    for (const [fileName, source] of Object.entries(declarations)) {
        fs.writeFileSync(path.join(interfaces, fileName), `${source}\n`);
    }
    return { entry: path.join(sourceDirectory, 'register-commands.ts'), generatedTypes };
}

/** Bundles a fixture as the plugin build does and analyzes the files esbuild included. */
async function analyze(entry: string, typesDir?: string, witDir?: string): Promise<UsedWitMethods | undefined> {
    const result = await esbuild.build({
        entryPoints: [entry],
        bundle: true,
        write: false,
        metafile: true,
        logLevel: 'silent',
        plugins: [
            {
                name: 'host-modules',
                setup(build) {
                    build.onResolve({ filter: /^(?:pumpkin|wasi):|\/build\/types\/bindings\// }, (args) => ({
                        path: args.path,
                        external: true,
                    }));
                },
            },
        ],
    });
    const inputs = Object.keys(result.metafile.inputs).map((input) => path.resolve(input));
    return findUsedWitMethods({
        entry,
        inputs,
        ...(typesDir === undefined ? {} : { typesDir }),
        ...(witDir === undefined ? {} : { witDir }),
    });
}

afterEach(() => {
    for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('findUsedWitMethods Pumpkin operations', () => {
    it('selects only statically registered events and ignores the generic Plugin forwarding method', async () => {
        const entry = fixture();
        fs.writeFileSync(
            entry,
            `type EventType = 'tick' | 'join';
interface Context { registerEvent(id: number, eventType: EventType, priority: 'normal', blocking: boolean): void; }
class Plugin {
    registerEvent(context: Context, eventType: EventType, handler: (event: unknown) => void): void {
        context.registerEvent(1, eventType, 'normal', true);
    }
}
class RuntimePlugin extends Plugin {
    subscribe(context: Context): void { this.registerEvent(context, 'tick', () => {}); }
}
`,
        );

        expect(await analyze(entry)).toEqual({
            pumpkinMethods: [],
            wasiMethods: [],
            eventTypes: ['tick'],
        });
    }, 60_000);

    it('falls back when a Plugin forwarding method registers through a bound context alias', async () => {
        const entry = fixture();
        fs.writeFileSync(
            entry,
            `type EventType = 'tick' | 'join';
interface Context { registerEvent(id: number, eventType: EventType, priority: 'normal', blocking: boolean): void; }
class Plugin {
    registerEvent(context: Context, eventType: EventType, handler: (event: unknown) => void): void {
        const register = context.registerEvent.bind(context);
        register(1, eventType === 'tick' ? 'join' : eventType, 'normal', true);
    }
}
class RuntimePlugin extends Plugin {
    subscribe(context: Context): void { this.registerEvent(context, 'tick', () => {}); }
}
`,
        );

        expect((await analyze(entry))?.eventTypes).toBeUndefined();
    }, 60_000);

    it('falls back when a Plugin forwarding method registers through a destructured context alias', async () => {
        const entry = fixture();
        fs.writeFileSync(
            entry,
            `type EventType = 'tick' | 'join';
interface Context { registerEvent(id: number, eventType: EventType, priority: 'normal', blocking: boolean): void; }
class Plugin {
    registerEvent(context: Context, eventType: EventType, handler: (event: unknown) => void): void {
        const { registerEvent: register } = context;
        register(1, eventType === 'tick' ? 'join' : eventType, 'normal', true);
    }
}
class RuntimePlugin extends Plugin {
    subscribe(context: Context): void { this.registerEvent(context, 'tick', () => {}); }
}
`,
        );

        expect((await analyze(entry))?.eventTypes).toBeUndefined();
    });

    it('retains all typed dynamic events and falls back when a registration name is untyped', async () => {
        const entry = fixture();
        fs.writeFileSync(
            entry,
            `type EventType = 'tick' | 'join';
interface Context { registerEvent(id: number, eventType: EventType, priority: 'normal', blocking: boolean): void; }
class Plugin { registerEvent(context: Context, eventType: EventType, handler: (event: unknown) => void): void { context.registerEvent(1, eventType, 'normal', true); } }
class RuntimePlugin extends Plugin {
    subscribeAll(context: Context, eventType: EventType): void { this.registerEvent(context, eventType, () => {}); }
    subscribeUnknown(context: Context, eventType: string): void { this.registerEvent(context, eventType, () => {}); }
}
`,
        );

        expect((await analyze(entry))?.eventTypes).toBeUndefined();
    });

    it('falls back when a computed method could invoke event registration', async () => {
        const entry = fixture();
        fs.writeFileSync(
            entry,
            `type EventType = 'tick' | 'join';
interface Context {
    registerEvent(id: number, eventType: EventType, priority: 'normal', blocking: boolean): void;
    noop(id: number, eventType: EventType, priority: 'normal', blocking: boolean): void;
}
class Plugin { registerEvent(context: Context, eventType: EventType, handler: (event: unknown) => void): void { context.registerEvent(1, eventType, 'normal', true); } }
class RuntimePlugin extends Plugin {
    subscribe(context: Context, method: 'registerEvent' | 'noop', eventType: EventType): void {
        context[method](1, eventType, 'normal', true);
    }
}
`,
        );

        expect((await analyze(entry))?.eventTypes).toBeUndefined();
    });

    it('reports called methods by their declared Pumpkin interface and resource', async () => {
        const methods = (await analyze(fixture()))?.pumpkinMethods;

        expect(methods).toEqual([
            'command.command.constructor',
            'context.context.register-event',
            'ipc.send-ipc-message',
            'player.java-player.send-custom-payload',
            'player.player.as-java',
            'player.player.get-position',
            'text.text-component.encode',
            'text.text-component.from-json',
            'world.world.get-name',
        ]);
    }, 30_000);

    it('maps jco names with single-letter segments back to their WIT names', async () => {
        const entry = fixture();
        const root = path.dirname(entry);
        fs.writeFileSync(
            path.join(root, 'build/types/bindings/interfaces/pumpkin-plugin-world.d.ts'),
            'export class World { getXY(): number; }\nexport function getABC(): number;\n',
        );
        const witDir = path.join(root, 'wit');
        fs.mkdirSync(witDir);
        fs.writeFileSync(
            path.join(witDir, 'world.wit'),
            'package pumpkin:plugin@0.1.0;\n\ninterface %world {\n    resource %world {\n        get-x-y: func() -> f64;\n    }\n    get-a-b-c: func() -> u32;\n}\n',
        );
        fs.writeFileSync(
            entry,
            'import { type World, getABC } from "./build/types/bindings/interfaces/pumpkin-plugin-world"; declare const world: World; world.getXY(); getABC();',
        );

        expect((await analyze(entry, undefined, witDir))?.pumpkinMethods).toEqual([
            'world.get-a-b-c',
            'world.world.get-x-y',
        ]);
    });

    it.each([
        'player["getPosition"]();',
        'const read = player.getPosition.bind(player); read();',
        'const read = player.getPosition; read.call(player);',
        'const { getPosition: read } = player; read.call(player);',
    ])('includes resource methods referenced through %s', async (usage) => {
        const entry = fixture();
        fs.writeFileSync(
            entry,
            `import type { Player } from "./build/types/bindings/interfaces/pumpkin-plugin-player"; declare const player: Player; ${usage}`,
        );
        expect((await analyze(entry))?.pumpkinMethods).toContain('player.player.get-position');
    });

    const playerImport =
        'import type { Player } from "./build/types/bindings/interfaces/pumpkin-plugin-player"; import * as ipc from "./build/types/bindings/interfaces/pumpkin-plugin-ipc"; declare const player: Player; declare const players: Player[]; declare const holder: { player: Player };';
    it.each([
        [
            'a typed parameter',
            'function send({ sendIpcMessage }: typeof ipc) { sendIpcMessage("plugin", new Uint8Array()); } send(ipc);',
            'ipc.send-ipc-message',
        ],
        [
            'a contextually typed parameter',
            'players.forEach(({ getPosition }) => getPosition.call(player));',
            'player.player.get-position',
        ],
        ['for-of', 'for (const { getPosition } of players) getPosition.call(player);', 'player.player.get-position'],
        [
            'a nested pattern',
            'const { player: { getWorld } } = holder; getWorld.call(player);',
            'player.player.get-world',
        ],
        [
            'an assignment',
            'let send; ({ sendIpcMessage: send } = ipc); send("plugin", new Uint8Array());',
            'ipc.send-ipc-message',
        ],
    ])('includes methods destructured in %s', async (_form, usage, method) => {
        const entry = fixture();
        fs.writeFileSync(entry, `${playerImport} ${usage}`);

        expect((await analyze(entry))?.pumpkinMethods).toContain(method);
    });

    it('follows members read from an untyped rest parameter in a JavaScript dependency', async () => {
        const entry = fixture();
        fs.writeFileSync(
            path.join(path.dirname(entry), 'helper.js'),
            'export function read({ id, ...player }) { return player.getPosition(); }',
        );
        fs.writeFileSync(
            entry,
            'import type { Player } from "./build/types/bindings/interfaces/pumpkin-plugin-player"; import { read } from "./helper.js"; declare const player: Player; read(player);',
        );

        expect((await analyze(entry))?.pumpkinMethods).toEqual(['player.player.get-position']);
    });

    it.each([
        ['a nested assignment', 'let read; ({ player: { getWorld: read } } = holder); read.call(player);'],
        ['a for-of assignment', 'let read; for ({ getPosition: read } of players) read.call(player);'],
        ['an array assignment', 'let read; [{ getPosition: read }] = players; read.call(player);'],
    ])('falls back to full adapters for methods destructured in %s', async (_form, usage) => {
        const entry = fixture();
        fs.writeFileSync(entry, `${playerImport} ${usage}`);

        expect(await analyze(entry)).toBeUndefined();
    });

    it('includes all possible resource methods for a dynamic member key', async () => {
        const entry = fixture();
        fs.writeFileSync(
            entry,
            'import type { Player } from "./build/types/bindings/interfaces/pumpkin-plugin-player"; declare const player: Player; declare const key: keyof Player; player[key]();',
        );
        expect((await analyze(entry))?.pumpkinMethods).toEqual([
            'player.player.as-java',
            'player.player.get-position',
            'player.player.get-world',
        ]);
    });

    it('includes constructors referenced through namespace imports', async () => {
        const entry = fixture();
        fs.writeFileSync(
            entry,
            'import * as commands from "./build/types/bindings/interfaces/pumpkin-plugin-command"; new commands.Command(["say"], "Send");',
        );
        expect((await analyze(entry))?.pumpkinMethods).toContain('command.command.constructor');
    });

    it.each([
        'import { Command } from "./build/types/bindings/interfaces/pumpkin-plugin-command"; const Create = Command; new Create(["say"], "Send");',
        'import * as commands from "./build/types/bindings/interfaces/pumpkin-plugin-command"; const Create = commands.Command; new Create(["say"], "Send");',
    ])('retains constructors referenced through local aliases: %s', async (usage) => {
        const entry = fixture();
        fs.writeFileSync(entry, usage);

        expect((await analyze(entry))?.pumpkinMethods).toContain('command.command.constructor');
    });

    it('falls back to full adapters when a constructor alias has an unknown type', async () => {
        const entry = fixture();
        fs.writeFileSync(entry, 'declare const Create: any; new Create();');

        expect(await analyze(entry)).toBeUndefined();
    });

    it('ignores generic dynamic indexing and constructors in runtime dependencies', async () => {
        const entry = fixture();
        const dependency = path.join(path.dirname(entry), 'node_modules/generic-library');
        fs.mkdirSync(dependency, { recursive: true });
        fs.writeFileSync(
            path.join(dependency, 'index.js'),
            'export function clone(values) { for (const value of values) { if (value.buffer) new value.constructor(value); } } export function create(registry, name) { const Constructor = registry[name]; return new Constructor(); }\n',
        );
        fs.writeFileSync(
            entry,
            'import { clone, create } from "./node_modules/generic-library/index.js"; import { Command } from "./build/types/bindings/interfaces/pumpkin-plugin-command"; clone([]); create({}, "codec"); create({ Command }, "Command");',
        );

        expect(await analyze(entry)).toEqual({
            pumpkinMethods: ['command.command.constructor'],
            wasiMethods: [],
            eventTypes: [],
        });
    });

    it.each([
        'export function invoke(value, key) { return value[key](); }',
        'export function invoke(value, key) { const method = value[key]; return method(); }',
    ])('falls back when a runtime dependency dynamically invokes an unknown member: %s', async (implementation) => {
        const entry = fixture();
        const dependency = path.join(path.dirname(entry), 'node_modules/generic-library');
        fs.mkdirSync(dependency, { recursive: true });
        fs.writeFileSync(path.join(dependency, 'index.js'), `${implementation}\n`);
        fs.writeFileSync(
            entry,
            'import { invoke } from "./node_modules/generic-library/index.js"; declare const resource: any; invoke(resource, "unknown");',
        );

        expect(await analyze(entry)).toBeUndefined();
    });

    it('analyzes the requested entry even when its tsconfig excludes it', async () => {
        const entry = fixture();
        const excludedEntry = path.join(path.dirname(entry), 'excluded.ts');
        fs.writeFileSync(
            excludedEntry,
            'import type { Player } from "./build/types/bindings/interfaces/pumpkin-plugin-player"; declare const player: Player; player.getWorld();',
        );
        expect((await analyze(excludedEntry))?.pumpkinMethods).toContain('player.player.get-world');
    });

    it.each([
        ['unparseable JSON', '{ "compilerOptions": '],
        ['an invalid option', JSON.stringify({ compilerOptions: { target: 'not-a-target' } })],
    ])('reports a tsconfig with %s as a build error', (_label, config) => {
        const entry = fixture();
        const configPath = path.join(path.dirname(entry), 'tsconfig.json');
        fs.writeFileSync(configPath, config);

        // esbuild rejects some of these first; the analysis must still report its own failure clearly.
        expect(() => findUsedWitMethods({ entry, inputs: [entry] })).toThrow(BuildError);
        expect(() => findUsedWitMethods({ entry, inputs: [entry] })).toThrow(configPath);
    });

    it('analyzes a plugin entry without tsconfig using generated WIT declarations', async () => {
        const entry = fixture();
        fs.rmSync(path.join(path.dirname(entry), 'tsconfig.json'));
        fs.writeFileSync(
            entry,
            'import type { Player } from "./build/types/bindings/interfaces/pumpkin-plugin-player"; declare const player: Player; player.getPosition();',
        );

        expect(await analyze(entry, path.join(path.dirname(entry), 'build/types/bindings'))).toEqual({
            pumpkinMethods: ['player.player.get-position'],
            wasiMethods: [],
            eventTypes: [],
        });
    });

    it('scans imported JavaScript implementations even when allowJs is disabled', async () => {
        const entry = fixture();
        fs.writeFileSync(
            path.join(path.dirname(entry), 'helper.js'),
            'import { sendIpcMessage } from "./build/types/bindings/interfaces/pumpkin-plugin-ipc"; export function send() { sendIpcMessage("plugin", new Uint8Array()); }',
        );
        fs.writeFileSync(entry, 'import { send } from "./helper.js"; send();');
        expect((await analyze(entry))?.pumpkinMethods).toContain('ipc.send-ipc-message');
    });

    it('scans dependency implementations shadowed by declarations', async () => {
        const entry = fixture();
        fs.writeFileSync(path.join(path.dirname(entry), 'helper.d.ts'), 'export function send(): void;');
        fs.writeFileSync(
            path.join(path.dirname(entry), 'helper.js'),
            'import { sendIpcMessage } from "./build/types/bindings/interfaces/pumpkin-plugin-ipc"; export function send() { sendIpcMessage("plugin", new Uint8Array()); }',
        );
        fs.writeFileSync(entry, 'import { send } from "./helper.js"; send();');
        expect((await analyze(entry))?.pumpkinMethods).toContain('ipc.send-ipc-message');
    });

    it('analyzes the browser build of a dependency that esbuild bundles', async () => {
        const entry = fixture();
        const dependency = path.join(path.dirname(entry), 'node_modules/split-dependency');
        fs.mkdirSync(dependency, { recursive: true });
        fs.writeFileSync(
            path.join(dependency, 'package.json'),
            JSON.stringify({ name: 'split-dependency', main: './node.js', browser: './browser.js' }),
        );
        fs.writeFileSync(path.join(dependency, 'node.js'), 'export function send() {}\n');
        fs.writeFileSync(
            path.join(dependency, 'browser.js'),
            'import { sendIpcMessage } from "../../build/types/bindings/interfaces/pumpkin-plugin-ipc"; export function send() { sendIpcMessage("plugin", new Uint8Array()); }\n',
        );
        fs.writeFileSync(entry, 'import { send } from "split-dependency"; send();');

        expect((await analyze(entry))?.pumpkinMethods).toContain('ipc.send-ipc-message');
    });

    it('falls back to full adapters when a bundled input is not a source file', async () => {
        const entry = fixture();
        fs.writeFileSync(entry, 'export {};');

        expect(findUsedWitMethods({ entry, inputs: [entry, 'virtual-plugin:generated-module'] })).toBeUndefined();
    });

    it('retains host methods called on untyped JavaScript dependency parameters', async () => {
        const entry = fixture();
        fs.writeFileSync(
            path.join(path.dirname(entry), 'helper.js'),
            'export function read(player) { return player.getPosition(); }',
        );
        fs.writeFileSync(
            entry,
            'import type { Player } from "./build/types/bindings/interfaces/pumpkin-plugin-player"; import { read } from "./helper.js"; declare const player: Player; read(player);',
        );
        expect((await analyze(entry))?.pumpkinMethods).toEqual(['player.player.get-position']);
    });

    it('falls back to full adapters for unknown dynamic resource members', async () => {
        const entry = fixture();
        fs.writeFileSync(entry, 'declare const resource: any; declare const key: string; resource[key]();');
        expect(await analyze(entry)).toBeUndefined();
    });

    it('retains namespace constructors accessed with string keys', async () => {
        const entry = fixture();
        fs.writeFileSync(
            entry,
            'import * as commands from "./build/types/bindings/interfaces/pumpkin-plugin-command"; new commands["Command"](["say"], "Send");',
        );
        expect((await analyze(entry))?.pumpkinMethods).toContain('command.command.constructor');
    });

    it('analyzes runtime entries inside directories named test', async () => {
        const entry = fixture();
        const testEntry = path.join(path.dirname(entry), 'test', 'plugin.ts');
        fs.mkdirSync(path.dirname(testEntry));
        fs.writeFileSync(
            testEntry,
            'import type { Player } from "../build/types/bindings/interfaces/pumpkin-plugin-player"; declare const player: Player; player.getPosition();',
        );
        expect((await analyze(testEntry))?.pumpkinMethods).toContain('player.player.get-position');
    });

    it('falls back when imported WIT bindings cannot be resolved', async () => {
        const entry = fixture();
        fs.writeFileSync(
            entry,
            'import { Command } from "pumpkin:plugin/command@0.1.0"; new Command(["say"], "Send");',
        );
        expect(await analyze(entry)).toBeUndefined();
    });

    it('falls back when imported WASI bindings cannot be resolved', async () => {
        const entry = fixture();
        fs.writeFileSync(entry, 'import { connect } from "wasi:sockets/unknown@0.2.3"; connect();');
        expect(await analyze(entry)).toBeUndefined();
    });

    it('falls back when a wildcard declaration hides an unresolved Pumpkin import', async () => {
        const entry = fixture();
        fs.writeFileSync(
            path.join(path.dirname(entry), 'build/types/bindings/interfaces/host-modules.d.ts'),
            'declare module "pumpkin:plugin/*";',
        );
        fs.writeFileSync(
            entry,
            'import { Command } from "pumpkin:plugin/command@0.1.0"; new Command(["say"], "Send");',
        );
        expect(await analyze(entry)).toBeUndefined();
    });

    it('ignores unresolved type-only Pumpkin imports when selecting adapters', async () => {
        const entry = fixture();
        fs.writeFileSync(
            entry,
            'import type { Command } from "pumpkin:plugin/command@0.1.0"; type PluginCommand = Command;',
        );
        expect(await analyze(entry)).toEqual({ pumpkinMethods: [], wasiMethods: [], eventTypes: [] });
    });

    it('includes command-node methods used through plugin-kit structural adapters', async () => {
        const { entry, generatedTypes } = pluginKitFixture();
        const methods = (await analyze(entry, generatedTypes))?.pumpkinMethods;

        expect(methods).toBeDefined();
        expect(methods).toContain('command.command-node.execute-with-handler-id');
        expect(methods).toContain('command.command-node.suggest-with-handler-id');
        expect(methods).toContain('command.command.then');
        expect(methods).toContain('command.command-node.then');
    }, 15_000);
});

describe('findUsedWitMethods WASI operations', () => {
    it('reports only called functions and resource methods from WASI declarations', async () => {
        const methods = (await analyze(fixture()))?.wasiMethods;

        expect(methods).toEqual([
            'wasi:sockets/instance-network@0.2.3#instance-network',
            'wasi:sockets/tcp@0.2.3#tcp-socket.start-connect',
        ]);
    });

    it('uses isolated generated declarations when package build types are absent', async () => {
        const { entry, generatedTypes } = isolatedWasiFixture();

        expect((await analyze(entry, generatedTypes))?.wasiMethods).toEqual([
            'wasi:sockets/tcp@0.2.3#tcp-socket.constructor',
            'wasi:sockets/tcp@0.2.3#tcp-socket.start-connect',
        ]);
    });
});
