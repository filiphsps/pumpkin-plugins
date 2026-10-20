import { startPumpkin } from '@pumpkin-plugins/test-harness';
import { expect, it } from 'vitest';
import { buildProbePlugin, saveEvidence } from './fixtures/probe-plugin.ts';

const source = /* TypeScript */ `
import * as logging from 'pumpkin:plugin/logging@0.1.0';
import { Plugin, registerPlugin } from '@pumpkin-plugins/pumpkin-api';
export * from '@pumpkin-plugins/pumpkin-api';
class EventResults extends Plugin {
    metadata() { return { name: 'EventResults', version: '0.0.0', authors: [], description: '', dependencies: [], permissions: [] }; }
    onLoad(context) {
        this.registerEvent(context, 'server-command-event', (_server, event) => {
            if (event.command === 'hermes-mutate') {
                event.cancelled = true;
                logging.log('info', 'mutated event payload');
            }
            if (event.command === 'hermes-replace') {
                logging.log('info', 'replaced event payload');
                return { command: event.command, cancelled: true };
            }
            if (event.command === 'hermes-control') logging.log('info', 'left event payload unchanged');
        });
        logging.log('info', 'EventResults ready');
    }
}
registerPlugin(new EventResults());
`;

it('returns mutated and replacement event payloads to Pumpkin', async () => {
    const probe = buildProbePlugin('event-results', source);
    const server = await startPumpkin({ name: 'static-hermes-event-results', plugins: [probe.wasm] });
    try {
        await server.waitForLog(/EventResults ready/);
        for (const [command, expectedLog, cancelled] of [
            ['hermes-mutate', 'mutated event payload', true],
            ['hermes-replace', 'replaced event payload', true],
            // The control is not cancelled, so Pumpkin must report it as unknown.
            ['hermes-control', 'left event payload unchanged', false],
        ] as const) {
            const fromIndex = server.lines.length;
            server.command(command);
            // Pumpkin applies `cancelled` but dispatches the original console input string.
            server.command('list');
            await server.waitForLog(/There are.*players online/, 10_000, fromIndex);
            const lines = server.lines.slice(fromIndex);
            saveEvidence(probe, command, [`> ${command}`, ...lines]);
            const output = lines.join('\n');
            expect(output).toContain(expectedLog);
            if (cancelled) expect(output).not.toContain(`Unknown command: ${command}`);
            else expect(output).toContain(`Unknown command: ${command}`);
        }
        expect(server.errors()).toEqual([]);
    } finally {
        await server.stop();
    }
}, 300_000);
