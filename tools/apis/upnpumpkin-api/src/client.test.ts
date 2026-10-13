import { describe, expect, it } from 'vitest';
import { PortMapClient, RejectedError, UnavailableError } from './client.ts';
import { decodeRequest, encodeReply, type Reply, type Request } from './protocol.ts';

function setup(answer: (request: Request) => Reply | Error) {
    const sent: { recipient: string; request: Request }[] = [];
    const client = new PortMapClient((recipient, bytes) => {
        const decoded = decodeRequest(bytes);
        if (!('request' in decoded)) throw new Error('client sent garbage');
        sent.push({ recipient, request: decoded.request });
        const reply = answer(decoded.request);
        if (reply instanceof Error) throw reply;
        return encodeReply(reply);
    });
    return { client, sent };
}

const request = { key: 'web', protocol: 'tcp', port: 8123, description: 'Packs' } as const;

describe('PortMapClient', () => {
    it('sends requests to UPnPumpkin and returns the status', () => {
        const { client, sent } = setup(() => ({ ok: true, status: { kind: 'pending' } }));
        expect(client.ensure(request)).toEqual({ kind: 'pending' });
        expect(client.status('web')).toEqual({ kind: 'pending' });
        client.release('web');
        expect(sent.map((s) => [s.recipient, s.request.op])).toEqual([
            ['UPnPumpkin', 'ensure'],
            ['UPnPumpkin', 'status'],
            ['UPnPumpkin', 'release']
        ]);
    });

    it('says unknown when the answer has no status, and returns network info', () => {
        const { client } = setup((r) =>
            r.op === 'info' ? { ok: true, info: { localAddress: '10.0.0.2' } } : { ok: true }
        );
        expect(client.status('x')).toEqual({ kind: 'unknown' });
        expect(client.info()).toEqual({ localAddress: '10.0.0.2' });
    });

    it('reports an unreachable plugin as UnavailableError', () => {
        const { client } = setup(() => new Error('plugin not found'));
        expect(() => client.ensure(request)).toThrow(UnavailableError);
        expect(() => client.ensure(request)).toThrow('plugin not found');
    });

    it('reports a refusal as RejectedError and an unreadable answer as unavailable', () => {
        const { client } = setup(() => ({ ok: false, error: 'port must be a number' }));
        expect(() => client.ensure(request)).toThrow(RejectedError);

        const odd = new PortMapClient(() => new Uint8Array([1, 2, 3]));
        expect(() => odd.info()).toThrow(UnavailableError);
    });
});
