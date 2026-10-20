import { startPumpkin } from '@pumpkin-plugins/test-harness';
import { expect, it } from 'vitest';
import { buildProbePlugin, saveEvidence } from './fixtures/probe-plugin.ts';

const source = /* TypeScript */ `
import type { Context } from 'pumpkin:plugin/context@0.1.0';
import * as logging from 'pumpkin:plugin/logging@0.1.0';
import { Plugin, registerPlugin } from '@pumpkin-plugins/pumpkin-api';

Promise.resolve().then(() => logging.log('info', 'MicrotaskProbe: top-level job ran'));

class MicrotaskProbe extends Plugin {
    metadata() {
        return { name: 'MicrotaskProbe', version: '0.0.0', authors: [], description: '', dependencies: [], permissions: [] };
    }
    onLoad(context: Context) {
        super.onLoad(context);
        Promise.resolve().then(() => logging.log('info', 'MicrotaskProbe: promise job ran'));
        void (async () => {
            await null;
            logging.log('info', 'MicrotaskProbe: awaited continuation ran');
        })();
    }
}
registerPlugin(new MicrotaskProbe());
export * from '@pumpkin-plugins/pumpkin-api';
`;

it('runs promise jobs that a plugin queues', async () => {
    const probe = buildProbePlugin('microtask-probe', source);
    const server = await startPumpkin({ name: 'static-hermes-microtasks', plugins: [probe.wasm] });
    try {
        await server.waitForLog(/MicrotaskProbe: top-level job ran/, 10_000);
        await server.waitForLog(/MicrotaskProbe: promise job ran/, 10_000);
        await server.waitForLog(/MicrotaskProbe: awaited continuation ran/, 10_000);
        expect(server.errors()).toEqual([]);
    } finally {
        saveEvidence(probe, 'microtasks', server.lines);
        await server.stop();
    }
}, 300_000);
