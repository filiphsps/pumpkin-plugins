import { PumpkinPlusPlusSession } from '@pumpkin-plugins/pumpkin-plus-plus-api';
import { vi } from 'vitest';

type BridgeProviderOptions = {
    poll?: (operationId: string, count: number) => 'running' | 'ready' | 'timeout';
    failFirstSubmit?: boolean;
};

/** Creates a configurable in-memory Pumpkin++ provider for Distant Horizons tests. */
export function bridgeProvider(options: BridgeProviderOptions = {}) {
    const requests: Record<string, unknown>[] = [];
    const operationIds: string[] = [];
    const polls = new Map<string, number>();
    const readyLeases = new Set<string>();
    let nextOperation = 0;
    let providerNow = 1000;
    let failFirstSubmit = options.failFirstSubmit ?? false;
    const send = (_recipient: string, bytes: Uint8Array) => {
        const request = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
        requests.push(request);
        let reply: Record<string, unknown>;
        if (request.op === 'probe') {
            reply = {
                v: 1,
                ok: true,
                provider: 'Pumpkin++',
                protocol: 1,
                hostRelease: 'test-release',
                hostSourceCommit: 'a'.repeat(40),
            };
        } else if (request.op === 'submit') {
            if (failFirstSubmit) {
                failFirstSubmit = false;
                throw new Error('Submit reply was lost');
            }
            const operationId = `operation-${++nextOperation}`;
            operationIds.push(operationId);
            polls.set(operationId, 0);
            reply = { v: 1, ok: true, state: 'queued', operationId };
        } else if (request.op === 'poll') {
            const operationId = String(request.operationId);
            const count = (polls.get(operationId) ?? 0) + 1;
            polls.set(operationId, count);
            const state = options.poll?.(operationId, count) ?? (count === 1 ? 'running' : 'ready');
            if (state === 'timeout') {
                reply = { v: 1, ok: false, code: 'timeout', operationId };
            } else if (state === 'running') {
                reply = { v: 1, ok: true, state: 'running', operationId };
            } else {
                const leaseId = `lease-${operationId}`;
                readyLeases.add(leaseId);
                reply = { v: 1, ok: true, state: 'ready', operationId, leaseId, remainingLeaseMs: 60_000 };
            }
        } else if (request.op === 'cancel') {
            reply = { v: 1, ok: true, state: 'cancelled', operationId: request.operationId };
        } else if (request.op === 'release') {
            readyLeases.delete(String(request.leaseId));
            reply = { v: 1, ok: true, released: true, leaseId: request.leaseId };
        } else {
            throw new Error(`Unexpected Pumpkin++ request ${String(request.op)}`);
        }
        return new TextEncoder().encode(JSON.stringify(reply));
    };
    return {
        provider: new PumpkinPlusPlusSession({ send, now: () => providerNow, warn: vi.fn() }),
        requests,
        operationIds,
        readyLeases,
        setNow: (value: number) => {
            providerNow = value;
        },
    };
}
