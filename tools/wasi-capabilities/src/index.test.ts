import { describe, expect, it } from 'vitest';
import { CAPABILITIES, capabilitiesForInterface, isCapability, WASI_VERSION, wasiInterfaces } from './index.ts';

describe('WASI capability metadata', () => {
    it('pins the supported WASI version and known capabilities', () => {
        expect(WASI_VERSION).toBe('0.2.3');
        expect(Object.keys(CAPABILITIES)).toEqual(['http', 'filesystem', 'sockets', 'udp']);
    });

    it('returns no imports when no capability is requested', () => {
        expect(wasiInterfaces([])).toEqual([]);
    });

    it('adds shared support interfaces once', () => {
        const interfaces = wasiInterfaces(['filesystem', 'sockets', 'udp']);

        expect(new Set(interfaces).size).toBe(interfaces.length);
        expect(interfaces).toContain('filesystem/preopens');
        expect(interfaces).toContain('sockets/tcp');
        expect(interfaces).toContain('sockets/udp-create-socket');
        expect(interfaces.filter((name) => name === 'io/poll')).toHaveLength(1);
    });

    it('narrows capability names and rejects inherited object properties', () => {
        expect(isCapability('sockets')).toBe(true);
        expect(isCapability('udp')).toBe(true);
        expect(isCapability('network')).toBe(false);
        expect(isCapability('toString')).toBe(false);
    });

    it('returns every capability that uses an interface', () => {
        expect(capabilitiesForInterface('http/types')).toEqual(['http']);
        expect(capabilitiesForInterface('sockets/network')).toEqual(['sockets', 'udp']);
        expect(capabilitiesForInterface('io/poll')).toEqual(['http', 'filesystem', 'sockets', 'udp']);
        expect(capabilitiesForInterface('unknown/interface')).toEqual([]);
        expect(capabilitiesForInterface('wasi:http/types@0.2.3')).toEqual([]);
    });
});
