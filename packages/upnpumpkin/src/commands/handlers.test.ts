import { commandInfos } from '@pumpkin-plugins/docs';
import { buildCommands } from '@pumpkin-plugins/plugin-kit/commands';
import {
    FakeCommandFailure,
    FakeCommandHost,
    type FakeNode,
    MemoryFiles,
    MemoryLogger
} from '@pumpkin-plugins/plugin-kit/testing';
import { FakeIgd, FakeNetwork } from '@pumpkin-plugins/port-mapping/testing';
import { describe, expect, it } from 'vitest';
import { PortForwarder } from '../forwarder.ts';
import { info } from '../info.ts';
import { commandHandlers } from './handlers.ts';
import { COMMAND_PERMISSION, commands } from './spec.ts';

function setup(igd = new FakeIgd()) {
    const net = new FakeNetwork([igd]);
    const forwarder = new PortForwarder(new MemoryFiles(), new MemoryLogger(), net);
    forwarder.start();
    const host = new FakeCommandHost();
    const built = buildCommands(host, commands, commandHandlers(forwarder));
    return { net, forwarder, host, root: built[0]?.node as FakeNode };
}

describe('the /upnp commands', () => {
    it('are registered exactly as the README lists them', () => {
        const { host, root } = setup();
        expect(host.usages(root).sort()).toEqual((info.commands ?? []).map((c) => c.usage).sort());
        expect(info.commands).toEqual(commandInfos(commands));
        expect(new Set(info.commands.map((c) => c.permission))).toEqual(
            new Set([`${COMMAND_PERMISSION}.status`, `${COMMAND_PERMISSION}.reload`])
        );
    });

    it('status reports the ports that were asked for', () => {
        const { host, root } = setup();
        const lines = host.run(root, ['upnp', 'status']);
        expect(lines[0]).toContain('No router found yet');
        expect(lines.some((l) => l.startsWith('java (TCP 25565)'))).toBe(true);
        expect(lines.some((l) => l.startsWith('bedrock (UDP 19132)'))).toBe(true);
    });

    it('reload says how many ports are kept open', () => {
        const { host, root } = setup();
        expect(host.run(root, ['upnp', 'reload'])).toEqual(['Reloaded the config. 2 ports are being kept open.']);
    });

    describe('with a router UPnPumpkin does not work with', () => {
        const blocked = () =>
            new FakeIgd({
                upnp: false,
                natPmp: false,
                webPages: { '/html/login/index.html': { body: '<title>Speedport Konfigurationsprogramm</title>' } }
            });
        const identified = (env: ReturnType<typeof setup>) => {
            for (
                const start = env.net.time;
                !env.forwarder.refusal && env.net.time - start < 30_000;
                env.net.time += 10
            )
                env.forwarder.tick();
        };

        it('status shows the reason in red, first, and does not claim the ports are opening', () => {
            const env = setup(blocked());
            identified(env);
            const sender = env.host.runAs(env.root, ['upnp', 'status']);
            expect(sender.errors).toHaveLength(1);
            expect(sender.lines[0]).toBe(sender.errors[0]);
            expect(sender.lines[0]).toContain('UPnPumpkin is disabled: Telekom Speedport');
            expect(sender.lines).toContain('java (TCP 25565): not opened');
            expect(sender.lines.some((l) => l.includes('looking for a router'))).toBe(false);
        });

        it('reload fails with the reason', () => {
            const env = setup(blocked());
            identified(env);
            expect(() => env.host.run(env.root, ['upnp', 'reload'])).toThrow(FakeCommandFailure);
            expect(() => env.host.run(env.root, ['upnp', 'reload'])).toThrow('UPnPumpkin is disabled');
        });

        it('status is plain and reload works for a router that is fine', () => {
            const env = setup();
            const sender = env.host.runAs(env.root, ['upnp', 'status']);
            expect(sender.errors).toEqual([]);
            expect(env.host.run(env.root, ['upnp', 'reload'])).toHaveLength(1);
        });
    });
});
