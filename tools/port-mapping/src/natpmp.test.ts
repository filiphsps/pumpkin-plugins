import { describe, expect, it } from 'vitest';
import { externalAddressRequest, mappingRequest, parseExternalAddress, parseMapping } from './natpmp.ts';

const reply = (bytes: number[]) => Uint8Array.from(bytes);

describe('NAT-PMP packets', () => {
    it('encodes the requests of RFC 6886', () => {
        expect([...externalAddressRequest()]).toEqual([0, 0]);
        expect([...mappingRequest('tcp', 25565, 25565, 3600)]).toEqual([0, 2, 0, 0, 99, 221, 99, 221, 0, 0, 14, 16]);
        expect(mappingRequest('udp', 19132, 0, 0)[1]).toBe(1);
    });

    it('reads the external address and rejects what is not that answer', () => {
        expect(parseExternalAddress(reply([0, 128, 0, 0, 0, 0, 0, 1, 93, 184, 216, 34]))).toEqual([93, 184, 216, 34]);
        expect(parseExternalAddress(reply([0, 129, 0, 0, 0, 0, 0, 1, 1, 2, 3, 4]))).toBeUndefined();
        expect(parseExternalAddress(reply([0, 128, 0, 0]))).toBeUndefined();
    });

    it('turns result codes into messages', () => {
        expect(() => parseExternalAddress(reply([0, 128, 0, 2, 0, 0, 0, 1, 0, 0, 0, 0]))).toThrow('refused');
        expect(() => parseExternalAddress(reply([0, 128, 0, 99, 0, 0, 0, 1, 0, 0, 0, 0]))).toThrow('code 99');
    });

    it('reads a mapping answer for the right protocol and port only', () => {
        const answer = reply([0, 130, 0, 0, 0, 0, 0, 5, 99, 221, 99, 222, 0, 0, 14, 16]);
        expect(parseMapping(answer, 'tcp', 25565)).toEqual({ externalPort: 25566, lifetime: 3600 });
        expect(parseMapping(answer, 'udp', 25565)).toBeUndefined();
        expect(parseMapping(answer, 'tcp', 1)).toBeUndefined();
    });
});
