import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { findUsedPumpkinWitMethods, findUsedWasiWitMethods } from './wit-method-usage.ts';

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
                types: []
            },
            include: ['entry.ts', 'build/types/**/*.d.ts']
        })
    );
    fs.writeFileSync(
        path.join(interfaces, 'pumpkin-plugin-player.d.ts'),
        'import type { World } from "./pumpkin-plugin-world";\nexport class Player { getPosition(): [number, number, number]; getWorld(): World; asJava(): JavaPlayer | undefined; }\nexport class JavaPlayer { sendCustomPayload(channel: string, data: Uint8Array): void; }\n'
    );
    fs.writeFileSync(path.join(interfaces, 'pumpkin-plugin-world.d.ts'), 'export class World { getName(): string; }\n');
    fs.writeFileSync(
        path.join(interfaces, 'pumpkin-plugin-context.d.ts'),
        'export type EventType = "tick"; export type EventPriority = "normal"; export class Context { registerEvent(id: number, type: EventType, priority: EventPriority, blocking: boolean): void; }\n'
    );
    fs.writeFileSync(
        path.join(interfaces, 'pumpkin-plugin-command.d.ts'),
        'export class Command { constructor(names: Array<string>, description: string); executeWithHandlerId(id: number): void; }\n'
    );
    fs.writeFileSync(
        path.join(interfaces, 'pumpkin-plugin-text.d.ts'),
        'export class TextComponent { static fromJson(json: string): TextComponent; encode(): Uint8Array; }\n'
    );
    fs.writeFileSync(
        path.join(interfaces, 'pumpkin-plugin-ipc.d.ts'),
        'export type Result<T, E> = { tag: "ok"; val: T } | { tag: "err"; val: E }; export function sendIpcMessage(recipient: string, message: Uint8Array): Result<Uint8Array, string>;\n'
    );
    fs.writeFileSync(
        path.join(interfaces, 'wasi-sockets-instance-network.d.ts'),
        'declare module "wasi:sockets/instance-network@0.2.3" { export function instanceNetwork(): Network; export class Network { private constructor(); } }\n'
    );
    fs.writeFileSync(
        path.join(interfaces, 'wasi-sockets-tcp.d.ts'),
        'declare module "wasi:sockets/tcp@0.2.3" { export class TcpSocket { private constructor(); startConnect(network: import("wasi:sockets/instance-network@0.2.3").Network): void; localAddress(): string; } }\n'
    );
    const dependency = path.join(root, 'node_modules/pumpkin-api/dist');
    fs.mkdirSync(dependency, { recursive: true });
    fs.writeFileSync(
        path.join(dependency, 'index.ts'),
        'import type { Context } from "../../../build/types/bindings/interfaces/pumpkin-plugin-context"; import { sendIpcMessage as sendIpc } from "../../../build/types/bindings/interfaces/pumpkin-plugin-ipc"; export function installEvents(ctx: Context) { ctx.registerEvent(1, "tick", "normal", true); sendIpc("PumpkinPIE", new Uint8Array()); }\n'
    );
    fs.writeFileSync(
        path.join(root, 'entry.ts'),
        'import { Command } from "./build/types/bindings/interfaces/pumpkin-plugin-command"; import { JavaPlayer, Player } from "./build/types/bindings/interfaces/pumpkin-plugin-player"; import { TextComponent } from "./build/types/bindings/interfaces/pumpkin-plugin-text"; import { World } from "./build/types/bindings/interfaces/pumpkin-plugin-world"; import { installEvents } from "./node_modules/pumpkin-api/dist/index"; import { instanceNetwork } from "wasi:sockets/instance-network@0.2.3"; import { TcpSocket } from "wasi:sockets/tcp@0.2.3";\ndeclare const player: Player; declare const world: World; declare const java: JavaPlayer; declare const socket: TcpSocket;\nnew Command(["say"], "Send a message"); player.getPosition(); player.asJava(); world.getName(); java.sendCustomPayload("x", new Uint8Array()); TextComponent.fromJson("{}").encode(); installEvents({} as never); instanceNetwork(); socket.startConnect(instanceNetwork());\nclass Local { getPosition() {} } new Local().getPosition();\n'
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
                types: []
            },
            include: ['entry.ts']
        })
    );
    fs.writeFileSync(
        path.join(generatedTypes, 'wasi-sockets-tcp.d.ts'),
        'declare module "wasi:sockets/tcp@0.2.3" { export class TcpSocket { constructor(); startConnect(): void; } }\n'
    );
    const entry = path.join(root, 'entry.ts');
    fs.writeFileSync(
        entry,
        'import { TcpSocket } from "wasi:sockets/tcp@0.2.3"; const socket = new TcpSocket(); socket.startConnect();\n'
    );
    return { entry, generatedTypes };
}

afterEach(() => {
    for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('findUsedPumpkinWitMethods', () => {
    it('reports called methods by their declared Pumpkin interface and resource', () => {
        const methods = findUsedPumpkinWitMethods(fixture());

        expect(methods).toEqual([
            'command.command.constructor',
            'context.context.register-event',
            'ipc.send-ipc-message',
            'player.java-player.send-custom-payload',
            'player.player.as-java',
            'player.player.get-position',
            'text.text-component.encode',
            'text.text-component.from-json',
            'world.world.get-name'
        ]);
    }, 15_000);

    it('includes command-node methods used through plugin-kit structural adapters', () => {
        const entry = fileURLToPath(new URL('../../plugin-kit/src/register-commands.ts', import.meta.url));
        const methods = findUsedPumpkinWitMethods(entry) ?? [];

        expect(methods).toContain('command.command-node.execute-with-handler-id');
        expect(methods).toContain('command.command-node.suggest-with-handler-id');
        expect(methods).toContain('command.command.then');
        expect(methods).toContain('command.command-node.then');
    }, 15_000);
});

describe('findUsedWasiWitMethods', () => {
    it('reports only called functions and resource methods from WASI declarations', () => {
        const methods = findUsedWasiWitMethods(fixture());

        expect(methods).toEqual([
            'wasi:sockets/instance-network@0.2.3#instance-network',
            'wasi:sockets/tcp@0.2.3#tcp-socket.start-connect'
        ]);
    });

    it('uses isolated generated declarations when package build types are absent', () => {
        const { entry, generatedTypes } = isolatedWasiFixture();

        expect(findUsedWasiWitMethods(entry, generatedTypes)).toEqual([
            'wasi:sockets/tcp@0.2.3#tcp-socket.constructor',
            'wasi:sockets/tcp@0.2.3#tcp-socket.start-connect'
        ]);
    });
});
