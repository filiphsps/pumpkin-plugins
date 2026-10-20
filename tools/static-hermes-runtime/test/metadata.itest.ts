import { startPumpkin } from '@pumpkin-plugins/test-harness';
import { expect, it } from 'vitest';
import { buildProbePlugin, saveEvidence } from './fixtures/probe-plugin.ts';

const source = /* TypeScript */ `
import { Plugin, registerPlugin } from '@pumpkin-plugins/pumpkin-api';

class MetadataProbe extends Plugin {
    metadata(): never {
        throw new Error('metadata probe failure');
    }
}
registerPlugin(new MetadataProbe());
export * from '@pumpkin-plugins/pumpkin-api';
`;

it('logs why the plugin metadata could not be read', async () => {
    const probe = buildProbePlugin('metadata-probe', source);
    const server = await startPumpkin({ name: 'static-hermes-metadata', plugins: [probe.wasm] });
    try {
        const line = await server.waitForLog(/could not read the plugin metadata/, 10_000);
        expect(line).toContain('metadata probe failure');
    } finally {
        saveEvidence(probe, 'metadata', server.lines);
        await server.stop();
    }
}, 300_000);
