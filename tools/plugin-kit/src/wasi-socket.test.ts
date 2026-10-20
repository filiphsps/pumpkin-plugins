import { describe, expect, it } from 'vitest';
import { fromIpSocketAddress, settle, toIpSocketAddress } from './wasi-socket.ts';

/** How a WASI socket call reports an error, as a thrown value. */
const wasiError = (code: string): Error => Object.assign(new Error(code), { payload: code });

describe('toIpSocketAddress', () => {
    it('describes an IPv4 endpoint the way WASI sockets take it', () => {
        expect(toIpSocketAddress({ address: [192, 168, 1, 1], port: 1900 })).toEqual({
            tag: 'ipv4',
            val: { address: [192, 168, 1, 1], port: 1900 },
        });
    });

    it('copies the address, so a later change to the endpoint does not move the socket', () => {
        const address: [number, number, number, number] = [10, 0, 0, 1];
        const socketAddress = toIpSocketAddress({ address, port: 80 });
        address[3] = 2;

        expect(socketAddress.val.address).toEqual([10, 0, 0, 1]);
    });
});

describe('fromIpSocketAddress', () => {
    it('reads the address and port of an IPv4 socket address', () => {
        expect(fromIpSocketAddress({ tag: 'ipv4', val: { address: [10, 0, 0, 7], port: 40000 } })).toEqual({
            address: [10, 0, 0, 7],
            port: 40000,
        });
    });

    it('offers nothing for IPv6, including loopback and IPv4-mapped addresses', () => {
        for (const address of [
            [0, 0, 0, 0, 0, 0, 0, 1],
            [0, 0, 0, 0, 0, 0xffff, 0xc0a8, 0x0101],
        ] as const)
            expect(
                fromIpSocketAddress({
                    tag: 'ipv6',
                    val: { address: [...address], port: 1900, flowInfo: 0, scopeId: 0 },
                }),
            ).toBeUndefined();
    });

    it('copies the address, so the result does not share the host value', () => {
        const address: [number, number, number, number] = [192, 168, 1, 50];
        const endpoint = fromIpSocketAddress({ tag: 'ipv4', val: { address, port: 50000 } });
        address[0] = 0;

        expect(endpoint?.address).toEqual([192, 168, 1, 50]);
    });

    it('reads back what toIpSocketAddress wrote', () => {
        const endpoint = { address: [255, 255, 255, 255] as const, port: 65535 };

        expect(fromIpSocketAddress(toIpSocketAddress(endpoint))).toEqual({
            address: [255, 255, 255, 255],
            port: 65535,
        });
    });
});

describe('settle', () => {
    it('returns what a step gives once it stops reporting would-block', () => {
        let calls = 0;
        const result = settle(() => {
            calls++;
            if (calls <= 3) throw wasiError('would-block');
            return 'bound';
        });

        expect(result).toBe('bound');
        expect(calls).toBe(4);
    });

    it('gives up after 100 attempts and rethrows would-block', () => {
        let calls = 0;

        expect(() =>
            settle(() => {
                calls++;
                throw wasiError('would-block');
            }),
        ).toThrow('would-block');
        expect(calls).toBe(100);
    });

    it('rethrows any other error at once', () => {
        let calls = 0;

        expect(() =>
            settle(() => {
                calls++;
                throw wasiError('address-in-use');
            }),
        ).toThrow('address-in-use');
        expect(calls).toBe(1);
    });
});
