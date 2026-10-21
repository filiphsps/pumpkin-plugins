import { strToU8 } from 'fflate';
import { expect, it } from 'vitest';
import { decodeReply, encodeRequest, IncompatibleError, InputError, ProtocolError } from './protocol.ts';

// Accepted byte seam. Failure surfaces: malformed/oversized UTF-8 or JSON,
// invalid fields/coordinates/IDs, wrong protocol/identity, contradictory variants,
// mismatched operation/lease IDs, and unbounded lease lifetimes.
const probe = { v: 1, op: 'probe' } as const;
const info = {
    provider: 'Pumpkin++',
    protocol: 1,
    hostRelease: '0.2.0+26.3-26.51',
    hostSourceCommit: '204a94ed895f041a845630d5a23c094705a0704e',
};
function bytes(value: unknown): Uint8Array {
    return strToU8(JSON.stringify(value));
}

it('negotiates the native coordination contract using literal interoperable bytes', () => {
    expect(encodeRequest(probe)).toEqual(strToU8('{"v":1,"op":"probe"}'));
    expect(
        decodeReply(
            strToU8(
                '{"v":1,"ok":true,"provider":"Pumpkin++","protocol":1,"hostRelease":"0.2.0+26.3-26.51","hostSourceCommit":"204a94ed895f041a845630d5a23c094705a0704e"}',
            ),
            probe,
        ),
    ).toEqual(info);
});

it('refuses malformed bytes and incompatible provider identities', () => {
    for (const raw of [
        new Uint8Array(8193),
        new Uint8Array([0xc0, 0x80]),
        new Uint8Array([0xed, 0xa0, 0x80]),
        new Uint8Array([0xf4, 0x90, 0x80, 0x80]),
        strToU8('{'),
        strToU8('null'),
        strToU8('[]'),
        strToU8('{}'),
        bytes({ v: 1, ok: true }),
    ])
        expect(() => decodeReply(raw, probe)).toThrow(ProtocolError);
    expect(() => decodeReply(bytes({ v: 2, ok: true, ...info }), probe)).toThrow(IncompatibleError);
    expect(() => decodeReply(bytes({ v: 1, ok: true, ...info, protocol: 2 }), probe)).toThrow(IncompatibleError);
    expect(() => decodeReply(bytes({ v: 1, ok: true, ...info, provider: 'Other' }), probe)).toThrow(IncompatibleError);
    expect(() => encodeRequest({ v: 2, op: 'probe' } as never)).toThrow(InputError);
    const prefix =
        '{"v":1,"ok":true,"provider":"Pumpkin++","protocol":1,"hostRelease":"0.2.0+26.3-26.51","hostSourceCommit":"204a94ed895f041a845630d5a23c094705a0704e","extra":"';
    const raw = strToU8(`${prefix}${'x'.repeat(8192 - prefix.length - 2)}"}`);
    expect(decodeReply(raw, probe)).toEqual(info);
    expect(() => decodeReply(new Uint8Array([...raw, 32]), probe)).toThrow(ProtocolError);
});

it('bounds chunk inputs and validates operation IDs and structured rejections', () => {
    const submit = { v: 1, op: 'submit', world: 'overworld', x: -1_000_000, z: 1_000_000 } as const;
    expect(encodeRequest(submit)).toEqual(
        strToU8('{"v":1,"op":"submit","world":"overworld","x":-1000000,"z":1000000}'),
    );
    for (const invalid of [
        { ...submit, x: 2147483648 },
        { ...submit, z: NaN },
        { ...submit, x: 0.5 },
        { ...submit, world: '' },
        { ...submit, world: 'é'.repeat(65) },
        { ...submit, world: '\ud800' },
        { v: 1, op: 'poll', operationId: '../other' },
        { v: 1, op: 'release', leaseId: 'x'.repeat(65) },
    ])
        expect(() => encodeRequest(invalid as never)).toThrow(InputError);
    const poll = { v: 1, op: 'poll', operationId: 'job-1' } as const;
    for (const state of ['queued', 'running'])
        expect(decodeReply(bytes({ v: 1, ok: true, state, operationId: 'job-1' }), poll)).toEqual({
            state,
            operationId: 'job-1',
        });
    expect(() => decodeReply(bytes({ v: 1, ok: true, state: 'queued', operationId: 'other' }), poll)).toThrow(
        ProtocolError,
    );
    expect(decodeReply(strToU8('{"v":1,"ok":false,"code":"busy"}'), submit)).toEqual({ code: 'busy' });
    expect(() => decodeReply(bytes({ v: 1, ok: false, code: 'unknown' }), submit)).toThrow(ProtocolError);
    expect(() =>
        decodeReply(bytes({ v: 1, ok: true, state: 'queued', operationId: 'job-1', leaseId: 'lease-1' }), poll),
    ).toThrow(ProtocolError);
});

it('keeps finite leases, terminal errors, cancellation and release correlated to caller handles', () => {
    const poll = { v: 1, op: 'poll', operationId: 'job-1' } as const;
    expect(
        decodeReply(
            bytes({ v: 1, ok: true, state: 'ready', operationId: 'job-1', leaseId: 'lease-1', remainingLeaseMs: 2000 }),
            poll,
        ),
    ).toEqual({ state: 'ready', operationId: 'job-1', leaseId: 'lease-1', remainingLeaseMs: 2000 });
    for (const code of ['timeout', 'host_failure', 'cancelled', 'expired'])
        expect(decodeReply(bytes({ v: 1, ok: false, code, operationId: 'job-1' }), poll)).toEqual({
            code,
            operationId: 'job-1',
        });
    for (const result of [
        { v: 1, ok: true, state: 'ready', operationId: 'job-1' },
        { v: 1, ok: true, state: 'ready', operationId: 'job-1', leaseId: 'lease-1', remainingLeaseMs: 60001 },
        { v: 1, ok: false, code: 'expired', operationId: 'other' },
    ])
        expect(() => decodeReply(bytes(result), poll)).toThrow(ProtocolError);
    expect(
        decodeReply(bytes({ v: 1, ok: true, state: 'cancelled', operationId: 'job-1' }), {
            v: 1,
            op: 'cancel',
            operationId: 'job-1',
        }),
    ).toEqual({ state: 'cancelled', operationId: 'job-1' });
    expect(
        decodeReply(bytes({ v: 1, ok: true, released: true, leaseId: 'lease-1' }), {
            v: 1,
            op: 'release',
            leaseId: 'lease-1',
        }),
    ).toEqual({ released: true, leaseId: 'lease-1' });
    expect(() =>
        decodeReply(bytes({ v: 1, ok: true, released: true, leaseId: 'other' }), {
            v: 1,
            op: 'release',
            leaseId: 'lease-1',
        }),
    ).toThrow(ProtocolError);
});

it('accepts 64-byte operation and lease IDs and refuses a 65th byte in either direction', () => {
    for (const op of ['poll', 'cancel'] as const) {
        expect(encodeRequest({ v: 1, op, operationId: 'j'.repeat(64) })).toEqual(
            bytes({ v: 1, op, operationId: 'j'.repeat(64) }),
        );
        expect(() => encodeRequest({ v: 1, op, operationId: 'j'.repeat(65) })).toThrow(InputError);
    }
    expect(encodeRequest({ v: 1, op: 'release', leaseId: 'l'.repeat(64) })).toEqual(
        bytes({ v: 1, op: 'release', leaseId: 'l'.repeat(64) }),
    );
    expect(() => encodeRequest({ v: 1, op: 'release', leaseId: 'l'.repeat(65) })).toThrow(InputError);
    const submit = { v: 1, op: 'submit', world: 'world', x: 0, z: 0 } as const;
    for (const [operationId, leaseId] of [
        ['j'.repeat(65), 'lease-1'],
        ['job-1', 'l'.repeat(65)],
    ]) {
        expect(() =>
            decodeReply(
                bytes({ v: 1, ok: true, state: 'ready', operationId, leaseId, remainingLeaseMs: 1000 }),
                submit,
            ),
        ).toThrow(ProtocolError);
    }
});

it('requires a correlated operation ID for poll host failure but permits pre-admission submit host failure', () => {
    const failure = { v: 1, ok: false, code: 'host_failure' };
    const poll = { v: 1, op: 'poll', operationId: 'job-1' } as const;
    expect(() => decodeReply(bytes(failure), poll)).toThrow(ProtocolError);
    expect(() => decodeReply(bytes({ ...failure, operationId: 'other' }), poll)).toThrow(ProtocolError);
    expect(decodeReply(bytes({ ...failure, operationId: 'job-1' }), poll)).toEqual({
        code: 'host_failure',
        operationId: 'job-1',
    });
    expect(decodeReply(bytes(failure), { v: 1, op: 'submit', world: 'world', x: 0, z: 0 })).toEqual({
        code: 'host_failure',
    });
});
