import { describe, expect, it } from 'vitest';
import { isCapability, wasiInterfaces } from './capabilities.ts';

describe('wasiInterfaces', () => {
    it('is empty when no capability is requested', () => {
        expect(wasiInterfaces([])).toEqual([]);
    });

    it('adds the support interfaces every capability needs', () => {
        expect(wasiInterfaces(['filesystem'])).toEqual([
            'filesystem/types',
            'filesystem/preopens',
            'io/poll',
            'io/streams',
            'clocks/monotonic-clock'
        ]);
    });

    it('combines capabilities without repeating anything', () => {
        const all = wasiInterfaces(['filesystem', 'sockets']);
        expect(new Set(all).size).toBe(all.length);
        expect(all).toContain('sockets/tcp');
        expect(all).toContain('filesystem/preopens');
        expect(all.filter((i) => i === 'io/poll')).toHaveLength(1);
    });
});

describe('udp', () => {
    it('imports the UDP interfaces and shares the network ones with sockets', () => {
        const all = wasiInterfaces(['sockets', 'udp']);
        expect(all).toContain('sockets/udp-create-socket');
        expect(all.filter((i) => i === 'sockets/network')).toHaveLength(1);
    });
});

describe('isCapability', () => {
    it('knows the capabilities and nothing else', () => {
        expect(isCapability('sockets')).toBe(true);
        expect(isCapability('udp')).toBe(true);
        expect(isCapability('network')).toBe(false);
        expect(isCapability('toString')).toBe(false);
    });
});
