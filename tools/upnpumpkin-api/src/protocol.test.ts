import { strToU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import { decodeReply, decodeRequest, encodeReply, encodeRequest } from './protocol.ts';

const ensure = { op: 'ensure', key: 'web', protocol: 'tcp', port: 8123, description: 'Packs' } as const;

describe('requests', () => {
    it('survive the trip', () => {
        for (const request of [
            ensure,
            { ...ensure, externalPort: 9000 },
            { op: 'status', key: 'web' },
            { op: 'release', key: 'web' },
            { op: 'info' }
        ] as const) {
            expect(decodeRequest(encodeRequest(request))).toEqual({ request: expect.objectContaining(request) });
        }
    });

    it('are checked field by field, since they come from other plugins', () => {
        const bad = (patch: Record<string, unknown>) =>
            decodeRequest(strToU8(JSON.stringify({ v: 1, ...ensure, ...patch })));
        expect(bad({ key: '' })).toEqual({ error: 'key must be a short non-empty string' });
        expect(bad({ key: 'x'.repeat(65) })).toHaveProperty('error');
        expect(bad({ protocol: 'icmp' })).toEqual({ error: 'protocol must be "tcp" or "udp"' });
        expect(bad({ port: 0 })).toHaveProperty('error');
        expect(bad({ port: 70000 })).toHaveProperty('error');
        expect(bad({ port: 80.5 })).toHaveProperty('error');
        expect(bad({ port: '80' })).toHaveProperty('error');
        expect(bad({ externalPort: -1 })).toHaveProperty('error');
        expect(bad({ description: '' })).toHaveProperty('error');
        expect(bad({ description: 'x'.repeat(101) })).toHaveProperty('error');
        expect(bad({ op: 'delete-everything' })).toEqual({ error: 'unknown operation delete-everything' });
        expect(bad({ v: 2 })).toEqual({ error: 'unsupported protocol version 2, expected 1' });
    });

    it('reject input that is not a JSON object', () => {
        for (const text of ['', 'nope', '42', 'null', '[]'])
            expect(decodeRequest(strToU8(text))).toHaveProperty('error');
    });
});

describe('replies', () => {
    it('survive the trip', () => {
        const replies = [
            { ok: true, status: { kind: 'open', via: 'upnp', address: '1.2.3.4', port: 8123 } },
            { ok: true, info: { localAddress: '192.168.1.5' } },
            { ok: false, error: 'nope' }
        ] as const;
        for (const reply of replies) expect(decodeReply(encodeReply(reply))).toEqual(reply);
    });

    it('are ignored when from another version or not replies at all', () => {
        expect(decodeReply(strToU8('{"v":2,"ok":true}'))).toBeUndefined();
        expect(decodeReply(strToU8('{"v":1}'))).toBeUndefined();
        expect(decodeReply(strToU8('garbage'))).toBeUndefined();
    });
});
