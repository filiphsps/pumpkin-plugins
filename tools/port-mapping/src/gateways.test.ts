import { describe, expect, it } from 'vitest';
import { discover } from './discover.ts';
import { PortInUseError } from './gateway.ts';
import { FakeIgd } from './testing/fake-igd.ts';
import { FakeNetwork, runSteps } from './testing/fake-network.ts';

const request = {
    protocol: 'tcp',
    internalPort: 8123,
    externalPort: 8123,
    description: 'Test',
    leaseSeconds: 3600
} as const;
const client = [192, 168, 1, 50] as const;

function gatewayOf(igd: FakeIgd, kind: 'upnp' | 'nat-pmp') {
    const net = new FakeNetwork([igd]);
    const found = runSteps(net, discover(net, { upnp: kind === 'upnp', natPmp: kind === 'nat-pmp' }));
    return { net, gateway: found.gateway };
}

describe('UPnP gateway', () => {
    it('adds a mapping with the arguments the router needs and deletes it again', () => {
        const igd = new FakeIgd();
        const { net, gateway } = gatewayOf(igd, 'upnp');
        expect(runSteps(net, gateway.addMapping(request, client))).toEqual({ externalPort: 8123, leaseSeconds: 3600 });
        expect(igd.mappings.get('tcp:8123')).toEqual({
            protocol: 'tcp',
            externalPort: 8123,
            internalPort: 8123,
            client: '192.168.1.50',
            description: 'Test',
            leaseSeconds: 3600
        });

        runSteps(net, gateway.deleteMapping(request));
        expect(igd.mappings.size).toBe(0);
        expect(net.leaks).toBe(0);
    });

    it('treats deleting a mapping that is not there as success', () => {
        const { net, gateway } = gatewayOf(new FakeIgd(), 'upnp');
        expect(() => runSteps(net, gateway.deleteMapping(request))).not.toThrow();
    });

    it('falls back to a permanent lease when the router only offers those', () => {
        const igd = new FakeIgd({ permanentLeasesOnly: true });
        const { net, gateway } = gatewayOf(igd, 'upnp');
        expect(runSteps(net, gateway.addMapping(request, client))).toEqual({ externalPort: 8123, leaseSeconds: 0 });
        expect(igd.mappings.get('tcp:8123')?.leaseSeconds).toBe(0);
    });

    it('reports a taken port as PortInUseError and other refusals as errors', () => {
        const { net, gateway } = gatewayOf(new FakeIgd({ takenPorts: [8123] }), 'upnp');
        expect(() => runSteps(net, gateway.addMapping(request, client))).toThrow(PortInUseError);

        const refused = gatewayOf(new FakeIgd({ failMappingWith: 501 }), 'upnp');
        expect(() => runSteps(refused.net, refused.gateway.addMapping(request, client))).toThrow('(501)');
    });
});

describe('NAT-PMP gateway', () => {
    it('maps and unmaps, taking the port the router gives', () => {
        const igd = new FakeIgd({ upnp: false, takenPorts: [8123] });
        const { net, gateway } = gatewayOf(igd, 'nat-pmp');
        const result = runSteps(net, gateway.addMapping(request, client));
        expect(result.externalPort).not.toBe(8123);
        expect(result.leaseSeconds).toBe(3600);
        expect(igd.mappings.size).toBe(1);

        runSteps(net, gateway.deleteMapping(request));
        expect(igd.mappings.size).toBe(0);
        expect(net.leaks).toBe(0);
    });

    it('asks for a finite lease even when a permanent one was wanted, since NAT-PMP has none', () => {
        const { net, gateway } = gatewayOf(new FakeIgd({ upnp: false }), 'nat-pmp');
        expect(runSteps(net, gateway.addMapping({ ...request, leaseSeconds: 0 }, client)).leaseSeconds).toBe(7200);
    });
});
