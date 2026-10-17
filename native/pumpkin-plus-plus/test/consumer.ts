import { Command, CommandNode } from 'pumpkin:plugin/command@0.1.0';
import * as logging from 'pumpkin:plugin/logging@0.1.0';
import type { Server } from 'pumpkin:plugin/server@0.1.0';
import { PumpkinPlusPlusClient } from '../../../tools/apis/pumpkin-plus-plus-api/src/client.ts';
import { onCommand, runCommand, runTask, scheduleDelayed } from '../../../tools/plugin-kit/src/host.ts';
import { ipcSend } from '../../../tools/plugin-kit/src/ipc.ts';
import { handleTask as apiTask, Plugin, registerPlugin } from '../../../tools/pumpkin-api/src/index.ts';

let commandServer: Server | undefined;

// All test command payloads are ASCII JSON (Unicode uses JSON escapes). Byte commands exercise
// invalid UTF-8 independently, without relying on either guest engine's TextEncoder implementation.
function send(text, recipient = 'Pumpkin++') {
    const bytes = text.startsWith('bytes:') ? JSON.parse(text.slice(6)) : Array.from(text, (c) => c.charCodeAt(0));
    const response = ipcSend(recipient, new Uint8Array(bytes));
    return String.fromCharCode(...response);
}

class Consumer extends Plugin {
    metadata() {
        return {
            name: 'BridgeConsumer',
            version: '0.0.0',
            authors: [],
            description: 'Native bridge fixture',
            dependencies: [],
            permissions: [],
        };
    }
    onLoad(ctx) {
        const command = new Command(['ppraw'], 'Send bridge bytes');
        const payload = CommandNode.argument('payload', { tag: 'string', val: 'greedy' });
        const id = onCommand((_sender, args) => {
            const text = args.getValue('payload').val;
            const response = text.startsWith('inspect:')
                ? send(text.slice(8), 'BridgeInspector')
                : text.startsWith('batch:')
                  ? JSON.stringify(JSON.parse(text.slice(6)).map((value) => JSON.parse(send(JSON.stringify(value)))))
                  : send(text);
            logging.log('info', `PP_REPLY:${response}`);
            return 1;
        });
        payload.executeWithHandlerId(id);
        command.then(payload);
        ctx.registerCommand(command, '');
        const generate = new Command(['ppgenerate'], 'Prove asynchronous custom generation and saved lookup');
        generate.executeWithHandlerId(
            onCommand(() => {
                if (!commandServer) throw new Error('Command server is unavailable');
                this.prepare(commandServer);
                return 1;
            }),
        );
        ctx.registerCommand(generate, '');
        logging.log('info', 'PP_GUEST_READY');
    }
    prepare(server) {
        const client = new PumpkinPlusPlusClient(ipcSend);
        const world = server.createWorld('bridge-air', 'overworld');
        let submitted = false;
        let callbacks = 0;
        let saved = false;
        const generator = this.registerChunkGenerator((phase, chunk) => {
            if (chunk.getX() === -200 && chunk.getZ() === 201) {
                if (!submitted) throw new Error('Generator entered before submit returned');
                if (saved) throw new Error('Saved chunk was regenerated');
                callbacks++;
                logging.log('info', `PP_GENERATOR:${phase}`);
            }
        });
        world.setChunkGenerator(generator);
        const name = world.getName();
        const first = client.submit({ world: name, x: -200, z: 201 });
        const second = client.submit({ world: name, x: -200, z: 201 });
        submitted = true;
        logging.log('info', `PP_SUBMITTED:${JSON.stringify([first, second])}`);
        let ticks = 0;
        const poll = (activeServer) => {
            ticks++;
            const ready = [first, second].map((job) => client.poll(job.operationId));
            if (ready.some((job) => 'code' in job)) throw new Error(`Preparation failed: ${JSON.stringify(ready)}`);
            if (!ready.every((job) => job.state === 'ready')) {
                scheduleDelayed(1, poll);
                return;
            }
            const chunk = world.getChunk(-200, 201);
            if (chunk?.getBlockStateId({ x: 0, y: 64, z: 0 }) !== 0 || callbacks === 0 || ticks < 1)
                throw new Error('Missing generated air or callbacks');
            chunk.drop();
            const inspect = JSON.parse(send(JSON.stringify({ world: name, x: -200, z: 201 }), 'BridgeInspector'));
            if (JSON.stringify(inspect.levels) !== '[43]')
                throw new Error(`Dedup ticket mismatch: ${JSON.stringify(inspect)}`);
            for (const job of ready) client.release(job.leaseId);
            const released = JSON.parse(send(JSON.stringify({ world: name, x: -200, z: 201 }), 'BridgeInspector'));
            if (released.levels.length !== 0) throw new Error('Release leaked a ticket');
            logging.log('info', `PP_GENERATED_AIR_READY:${JSON.stringify({ ticks, callbacks, inspect, released })}`);
            activeServer.unloadWorld(name);
            const reloaded = activeServer.createWorld('bridge-air', 'overworld');
            saved = true;
            reloaded.setChunkGenerator(generator);
            const disk = client.submit({ world: reloaded.getName(), x: -200, z: 201 });
            const savedPoll = (_activeServer) => {
                const response = client.poll(disk.operationId);
                if ('code' in response) throw new Error(`Saved load failed: ${JSON.stringify(response)}`);
                if (response.state !== 'ready') {
                    scheduleDelayed(1, savedPoll);
                    return;
                }
                const chunk = reloaded.getChunk(-200, 201);
                if (chunk?.getBlockStateId({ x: 0, y: 64, z: 0 }) !== 0) throw new Error('Saved air unavailable');
                chunk.drop();
                logging.log('info', `PP_SAVED_AIR_READY:${JSON.stringify(response)}`);
                scheduleDelayed(12, (_activeServer) => {
                    const expired = JSON.parse(
                        send(JSON.stringify({ v: 1, op: 'poll', operationId: disk.operationId })),
                    );
                    const clean = JSON.parse(send(JSON.stringify({ world: name, x: -200, z: 201 }), 'BridgeInspector'));
                    if (expired.code !== 'expired' || clean.levels.length !== 0)
                        throw new Error(`Lease expiry leaked: ${JSON.stringify({ expired, clean })}`);
                    logging.log('info', `PP_LEASE_EXPIRED:${JSON.stringify({ expired, clean })}`);
                    const last = client.submit({ world: name, x: -200, z: 201 });
                    const close = (activeServer) => {
                        const held = JSON.parse(
                            send(JSON.stringify({ v: 1, op: 'poll', operationId: last.operationId })),
                        );
                        if (held.code) throw new Error(`World close preparation failed: ${JSON.stringify(held)}`);
                        if (held.state !== 'ready') {
                            scheduleDelayed(1, close);
                            return;
                        }
                        activeServer.unloadWorld(name);
                        const closed = JSON.parse(
                            send(JSON.stringify({ v: 1, op: 'poll', operationId: last.operationId })),
                        );
                        if (closed.ok || closed.code !== 'host_failure')
                            throw new Error(`Closed world reported ready: ${JSON.stringify(closed)}`);
                        logging.log('info', `PP_WORLD_UNLOADED:${JSON.stringify(closed)}`);
                    };
                    scheduleDelayed(1, close);
                });
            };
            scheduleDelayed(1, savedPoll);
        };
        scheduleDelayed(1, poll);
    }
}
registerPlugin(new Consumer());

export * from '../../../tools/pumpkin-api/src/index.ts';

export function handleCommand(id, sender, _server, args) {
    commandServer = _server;
    try {
        return runCommand(id, sender, args);
    } finally {
        commandServer = undefined;
    }
}

export function handleTask(id, server) {
    if (!runTask(id, server)) apiTask(id, server);
}
