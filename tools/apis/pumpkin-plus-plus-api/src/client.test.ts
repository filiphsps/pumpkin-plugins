import { strToU8 } from 'fflate';
import { expect, it } from 'vitest';
import { PumpkinPlusPlusClient } from './client.ts';
import { decodeJson, InputError } from './protocol.ts';

// Accepted typed-client seam: injected IPC is the external boundary. Failure
// surfaces: rejection loss, operation mismatches, invalid inputs sent to host,
// replay after uncertain submit, eager probing, stale compatibility, retry storms,
// ambiguous host failures mislabeled missing,
// duplicate warnings across recreated sessions, invalid/backward clocks.
it('submits, polls across callbacks, cancels and releases through typed control calls', () => {
    const inputs: unknown[] = [];
    const replies = [
        '{"v":1,"ok":true,"state":"queued","operationId":"job-1"}',
        '{"v":1,"ok":true,"state":"ready","operationId":"job-1","leaseId":"lease-1","remainingLeaseMs":1000}',
        '{"v":1,"ok":true,"state":"cancelled","operationId":"job-1"}',
        '{"v":1,"ok":true,"released":true,"leaseId":"lease-1"}',
        '{"v":1,"ok":false,"code":"busy"}',
    ];
    const client = new PumpkinPlusPlusClient((recipient, bytes) => {
        expect(recipient).toBe('Pumpkin++');
        inputs.push(decodeJson(bytes));
        return strToU8(replies.shift() ?? '');
    });
    const job = client.submit({ world: 'overworld', x: -2, z: 3 });
    expect(job).toEqual({ state: 'queued', operationId: 'job-1' });
    expect(client.poll('job-1')).toEqual({
        state: 'ready',
        operationId: 'job-1',
        leaseId: 'lease-1',
        remainingLeaseMs: 1000,
    });
    expect(client.cancel('job-1')).toEqual({ state: 'cancelled', operationId: 'job-1' });
    expect(client.release('lease-1')).toEqual({ released: true, leaseId: 'lease-1' });
    expect(client.submit({ world: 'overworld', x: 0, z: 0 })).toEqual({ code: 'busy' });
    expect(() => client.submit({ world: 'overworld', x: Infinity, z: 0 })).toThrow(InputError);
    expect(inputs).toHaveLength(5);
});
