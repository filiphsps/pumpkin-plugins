import { type PumpkinInstance, startPumpkin } from '@pumpkin-plugins/test-harness';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { buildProbePlugin, type ProbePlugin, saveEvidence } from './fixtures/probe-plugin.ts';

const source = /* TypeScript */ `
import type { CommandSender, ConsumedArgs } from 'pumpkin:plugin/command@0.1.0';
import type { Context } from 'pumpkin:plugin/context@0.1.0';
import * as logging from 'pumpkin:plugin/logging@0.1.0';
import type { Server } from 'pumpkin:plugin/server@0.1.0';
import { CommandFailed, defineCommands } from '@pumpkin-plugins/docs';
import { runCommand } from '@pumpkin-plugins/plugin-kit/host';
import { registerCommands } from '@pumpkin-plugins/plugin-kit/register-commands';
import { handleCommand as apiHandleCommand, Plugin, registerPlugin } from '@pumpkin-plugins/pumpkin-api';

const commands = defineCommands('CommandProbe', {
    'probe-players': {
        description: 'Count the selected players',
        permission: 'CommandProbe:command.players',
        arguments: [{ name: 'targets', type: 'players' }],
    },
    'probe-fail': { description: 'Fail with a message', permission: 'CommandProbe:command.fail' },
});

class CommandProbe extends Plugin {
    metadata() {
        return { name: 'CommandProbe', version: '0.0.0', authors: [], description: '', dependencies: [], permissions: [] };
    }
    onLoad(context: Context) {
        super.onLoad(context);
        registerCommands(context, commands, {
            'probe-players <targets>': (_sender, { targets }) => ['probe selected ' + targets.length + ' players'],
            'probe-fail': () => {
                throw new CommandFailed('probe failure message');
            },
        });
        logging.log('info', 'CommandProbe ready');
    }
}
registerPlugin(new CommandProbe());

export function handleCommand(id: number, sender: CommandSender, server: Server, args: ConsumedArgs): number {
    return runCommand(id, sender, args) ?? apiHandleCommand(id, sender, server, args);
}
export * from '@pumpkin-plugins/pumpkin-api';
`;

let probe: ProbePlugin;
let server: PumpkinInstance | undefined;

beforeAll(async () => {
    probe = buildProbePlugin('command-probe', source);
    server = await startPumpkin({ name: 'static-hermes-commands', plugins: [probe.wasm] });
    await server.waitForLog(/CommandProbe ready/);
}, 300_000);

afterAll(async () => {
    if (server) expect(server.errors()).toEqual([]);
    await server?.stop();
});

/** Runs a console command and returns the log lines it produced. */
async function run(scenario: string, command: string): Promise<string> {
    if (!server) throw new Error('Pumpkin did not start');
    const fromIndex = server.lines.length;
    server.command(command);
    // `list` runs after the probe command, so its reply marks the end of the probe's output.
    server.command('list');
    await server.waitForLog(/There are.*players online/, 10_000, fromIndex);
    const lines = server.lines.slice(fromIndex);
    saveEvidence(probe, scenario, [`> ${command}`, ...lines]);
    return lines.join('\n');
}

it('passes a players argument to a plugin-kit command handler', async () => {
    const output = await run('players-argument', 'probe-players @a');
    expect(output).toContain('probe selected 0 players');
    expect(output).not.toContain('missing or invalid');
});

it('shows the message of a plugin-kit CommandFailed to the sender', async () => {
    const output = await run('command-failed', 'probe-fail');
    expect(output).toContain('probe failure message');
    expect(output).not.toContain('Invalid consumption');
});
