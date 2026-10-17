import { strToU8 } from 'fflate';
import { expect, it } from 'vitest';
import { TransportError } from './client.ts';
import { decodeJson, InputError } from './protocol.ts';
import { PumpkinPlusPlusSession, WarningScope } from './session.ts';

it('probes on use, caches briefly, and returns typed availability without replaying an uncertain submit', () => {
    let now = 0;
    let reachable = true;
    const operations: string[] = [];
    const session = new PumpkinPlusPlusSession({
        now: () => now,
        warn: () => {},
        send: (_recipient, bytes) => {
            const { op } = decodeJson(bytes) as { op: string };
            operations.push(op);
            if (!reachable) throw new Error('unit WIT error');
            return strToU8(
                JSON.stringify({
                    v: 1,
                    ok: true,
                    ...(op === 'probe'
                        ? {
                              provider: 'Pumpkin++',
                              protocol: 1,
                              hostRelease: '0.2.0+26.3-26.51',
                              hostSourceCommit: '204a94ed895f041a845630d5a23c094705a0704e',
                          }
                        : { state: 'queued', operationId: 'job-1' }),
                }),
            );
        },
    });
    expect(session.state).toEqual({ kind: 'unknown' });
    expect(operations).toEqual([]);
    expect(session.submit({ world: 'world', x: 0, z: 0 })).toEqual({
        ok: true,
        value: { state: 'queued', operationId: 'job-1' },
    });
    expect(session.availability().kind).toBe('available');
    expect(operations).toEqual(['probe', 'submit']);
    now = 30000;
    expect(session.availability().kind).toBe('available');
    reachable = false;
    expect(session.submit({ world: 'world', x: 1, z: 1 })).toEqual({
        ok: false,
        error: { status: 'provider_error', kind: 'temporarily_unreachable', phase: 'operation' },
    });
    expect(session.submit({ world: 'world', x: 1, z: 1 }).ok).toBe(false);
    expect(operations).toEqual(['probe', 'submit', 'probe', 'submit']);
    now += 1000;
    reachable = true;
    expect(session.availability().kind).toBe('available');
    expect(operations.at(-1)).toBe('probe');
});

it('warns once across session recreation only for evidenced missing or incompatible providers', () => {
    const warnings: string[] = [];
    const scope = new WarningScope();
    let mode: 'generic' | 'missing' | 'incompatible' | 'busy' | 'available' = 'generic';
    const options = {
        now: () => 0,
        warnings: scope,
        warn: (message: string) => warnings.push(message),
        send: (_recipient: string, raw: Uint8Array) => {
            if (mode === 'generic') throw new Error('ambiguous WIT error');
            if (mode === 'missing') throw new TransportError('missing');
            if (mode === 'incompatible') return strToU8('{"v":2,"ok":true}');
            const { op } = decodeJson(raw) as { op: string };
            if (mode === 'busy' && op === 'submit') return strToU8('{"v":1,"ok":false,"code":"busy"}');
            return strToU8(
                JSON.stringify(
                    op === 'probe'
                        ? {
                              v: 1,
                              ok: true,
                              provider: 'Pumpkin++',
                              protocol: 1,
                              hostRelease: '0.2.0+26.3-26.51',
                              hostSourceCommit: '204a94ed895f041a845630d5a23c094705a0704e',
                          }
                        : { v: 1, ok: true, state: 'queued', operationId: 'job-1' },
                ),
            );
        },
    };
    expect(new PumpkinPlusPlusSession(options).availability().kind).toBe('temporarily_unreachable');
    mode = 'busy';
    const busy = new PumpkinPlusPlusSession(options);
    expect(busy.submit({ world: 'world', x: 0, z: 0 })).toEqual({ ok: false, error: { code: 'busy' } });
    expect(busy.state.kind).toBe('available');
    expect(warnings).toEqual([]);
    mode = 'missing';
    expect(new PumpkinPlusPlusSession(options).availability().kind).toBe('missing');
    mode = 'incompatible';
    expect(new PumpkinPlusPlusSession(options).availability().kind).toBe('incompatible');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(
        'https://github.com/filiphsps/pumpkin-plugins/tree/master/native/pumpkin-plus-plus#readme',
    );
    // Default ownership also survives recreating a session within a single module load.
    const defaults: string[] = [];
    const defaultOptions = { ...options, warnings: undefined, warn: (message: string) => defaults.push(message) };
    new PumpkinPlusPlusSession(defaultOptions).availability();
    new PumpkinPlusPlusSession(defaultOptions).availability();
    expect(defaults).toHaveLength(1);
});

it('caps retry backoff, recovers only on demand, and rejects invalid or backward clocks', () => {
    let now = 0;
    const calls: number[] = [];
    const options = {
        now: () => now,
        warn: () => {},
        send: () => {
            calls.push(now);
            throw new Error('unreachable');
        },
    };
    const session = new PumpkinPlusPlusSession(options);
    for (const due of [0, 1000, 3000, 7000, 15000, 31000, 61000, 91000]) {
        now = due;
        expect(session.availability().kind).toBe('temporarily_unreachable');
        now = due + 1;
        session.availability();
    }
    expect(calls).toEqual([0, 1000, 3000, 7000, 15000, 31000, 61000, 91000]);
    for (const invalid of [NaN, Infinity, -1, Number.MAX_SAFE_INTEGER])
        expect(() => new PumpkinPlusPlusSession({ ...options, now: () => invalid }).availability()).toThrow(InputError);
    now = 0;
    expect(() => session.availability()).toThrow(InputError);
});

it('snapshots submit inputs before probing and never sends invalid inputs', () => {
    const target = { world: 'world', x: 0, z: 0, op: 'release' };
    const inputs: unknown[] = [];
    const session = new PumpkinPlusPlusSession({
        now: () => 0,
        warn: () => {},
        send: (_recipient, raw) => {
            const request = decodeJson(raw) as { op: string };
            inputs.push(request);
            target.x = 4;
            return strToU8(
                JSON.stringify(
                    request.op === 'probe'
                        ? {
                              v: 1,
                              ok: true,
                              provider: 'Pumpkin++',
                              protocol: 1,
                              hostRelease: '0.2.0+26.3-26.51',
                              hostSourceCommit: '204a94ed895f041a845630d5a23c094705a0704e',
                          }
                        : { v: 1, ok: true, state: 'queued', operationId: 'job-1' },
                ),
            );
        },
    });
    expect(() => session.submit({ ...target, x: NaN })).toThrow(InputError);
    expect(inputs).toEqual([]);
    expect(session.submit(target).ok).toBe(true);
    expect(inputs).toEqual([
        { v: 1, op: 'probe' },
        { v: 1, op: 'submit', world: 'world', x: 0, z: 0 },
    ]);
});
