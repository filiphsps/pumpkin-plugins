import { describe, expect, it } from 'vitest';
import { discover } from './discover.ts';
import { RouterRefusedError } from './identify.ts';
import { FakeIgd } from './testing/fake-igd.ts';
import { FakeNetwork, runSteps } from './testing/fake-network.ts';

const both = { upnp: true, natPmp: true };

describe('discover', () => {
    it('finds a UPnP router through the multicast search and reads its external address', () => {
        const igd = new FakeIgd({ natPmp: false });
        const net = new FakeNetwork([igd]);
        const found = runSteps(net, discover(net, both));
        expect(found.gateway.kind).toBe('upnp');
        expect(found.gateway.address).toEqual([192, 168, 1, 1]);
        expect(found.externalAddress).toEqual([93, 184, 216, 34]);
        expect(net.leaks).toBe(0);
    });

    it('asks twice, because UDP is lossy, and sends one search per target', () => {
        const net = new FakeNetwork([new FakeIgd({ upnp: false, natPmp: false })]);
        expect(() => runSteps(net, discover(net, { upnp: true, natPmp: false }))).toThrow(
            'no router answered the search'
        );
        const searches = net.sent.filter((s) => s.to.port === 1900);
        expect(searches).toHaveLength(10);
    });

    it('finds a NAT-PMP router at the first address of the local network', () => {
        const net = new FakeNetwork([new FakeIgd({ upnp: false })]);
        const found = runSteps(net, discover(net, both));
        expect(found.gateway.kind).toBe('nat-pmp');
        expect(found.externalAddress).toEqual([93, 184, 216, 34]);
        expect(net.leaks).toBe(0);
    });

    it('prefers UPnP when both answer', () => {
        const net = new FakeNetwork([new FakeIgd()]);
        expect(runSteps(net, discover(net, both)).gateway.kind).toBe('upnp');
    });

    it('uses only the protocols that are turned on', () => {
        const net = new FakeNetwork([new FakeIgd()]);
        expect(runSteps(net, discover(net, { upnp: false, natPmp: true })).gateway.kind).toBe('nat-pmp');
        expect(() => runSteps(net, discover(net, { upnp: false, natPmp: false }))).toThrow('both turned off');
    });

    it('honours an explicit NAT-PMP gateway and an explicit search address', () => {
        const igd = new FakeIgd({ address: [10, 9, 8, 7] });
        const net = new FakeNetwork([igd]);
        net.local = [192, 168, 1, 50];
        const found = runSteps(
            net,
            discover(net, { upnp: false, natPmp: true, natPmpGateway: { address: [10, 9, 8, 7], port: 5351 } })
        );
        expect(found.gateway.address).toEqual([10, 9, 8, 7]);

        const upnp = runSteps(
            net,
            discover(net, { upnp: true, natPmp: false, ssdp: { address: [10, 9, 8, 7], port: 1900 } })
        );
        expect(upnp.gateway.kind).toBe('upnp');
    });

    it('says why each protocol found nothing', () => {
        const net = new FakeNetwork([]);
        expect(() => runSteps(net, discover(net, both))).toThrow(
            'UPnP: no router answered the search; NAT-PMP: no answer from 192.168.1.1 or 192.168.1.254'
        );
    });

    it('skips NAT-PMP when this machine has no route', () => {
        const net = new FakeNetwork([]);
        net.local = undefined;
        expect(() => runSteps(net, discover(net, { upnp: false, natPmp: true }))).toThrow('no route');
    });

    it('survives a router whose description cannot be fetched', () => {
        const igd = new FakeIgd({ natPmp: false });
        const net = new FakeNetwork([igd]);
        const broken = new FakeIgd({ natPmp: false, address: [192, 168, 1, 1], httpPort: 6000 });
        broken.handleHttp = () => ({ status: 500, body: '' });
        net.routers.push(broken);
        expect(runSteps(net, discover(net, { upnp: true, natPmp: false })).gateway.kind).toBe('upnp');
    });

    describe('with a screen', () => {
        const refuseTelekom = (identity: { manufacturer?: string }) =>
            identity.manufacturer?.includes('Telekom') ? 'no UPnP on Telekom' : undefined;
        const speedport = { '/html/login/index.html': { body: '<title>Speedport Konfigurationsprogramm</title>' } };

        it('refuses a router recognised by its web interface before sending it anything', () => {
            const net = new FakeNetwork([new FakeIgd({ upnp: false, natPmp: false, webPages: speedport })]);
            let refusal: unknown;
            try {
                runSteps(net, discover(net, { ...both, screen: refuseTelekom }));
            } catch (err) {
                refusal = err;
            }
            expect(refusal).toBeInstanceOf(RouterRefusedError);
            expect(refusal).toMatchObject({ reason: 'no UPnP on Telekom', identity: { manufacturer: 'Telekom' } });
            expect(net.sent).toHaveLength(0);
            expect(net.leaks).toBe(0);
        });

        it('refuses a UPnP router by its description and sends no NAT-PMP request or action to it', () => {
            const igd = new FakeIgd({ device: { manufacturer: 'Telekom AG' } });
            const net = new FakeNetwork([igd]);
            expect(() => runSteps(net, discover(net, { ...both, screen: refuseTelekom }))).toThrow(RouterRefusedError);
            expect(igd.actions).toEqual([]);
            expect(net.sent.every((s) => s.to.port === 1900)).toBe(true);
            expect(net.leaks).toBe(0);
        });

        it('passes the identity of the router it lets through on', () => {
            const net = new FakeNetwork([
                new FakeIgd({ device: { manufacturer: 'AVM', modelName: 'FRITZ!Box 7590' } })
            ]);
            const found = runSteps(net, discover(net, { ...both, screen: refuseTelekom }));
            expect(found.identity).toMatchObject({ manufacturer: 'AVM', model: 'FRITZ!Box 7590', source: 'upnp' });
        });

        it('gives NAT-PMP routers the identity from the web interface', () => {
            const net = new FakeNetwork([
                new FakeIgd({
                    upnp: false,
                    webPages: { '/html/login/index.html': { body: '<title>Speedport X</title>' } }
                })
            ]);
            const found = runSteps(net, discover(net, { ...both, screen: () => undefined }));
            expect(found.gateway.kind).toBe('nat-pmp');
            expect(found.identity).toMatchObject({ manufacturer: 'Telekom' });
        });

        it('leaves routers alone that say nothing about themselves, and does not probe without a screen', () => {
            const net = new FakeNetwork([new FakeIgd()]);
            expect(runSteps(net, discover(net, { ...both, screen: refuseTelekom })).identity).toBeUndefined();

            const plain = new FakeNetwork([new FakeIgd({ webPages: speedport })]);
            runSteps(plain, discover(plain, both));
            // Only the description and the external address were fetched: no web page.
            expect(plain.connections).toHaveLength(2);
        });

        it('uses a router that is not turned down when another one is', () => {
            const telekom = new FakeIgd({ address: [192, 168, 1, 1], device: { manufacturer: 'Telekom AG' } });
            const other = new FakeIgd({ address: [192, 168, 1, 2], httpPort: 6000, device: { manufacturer: 'AVM' } });
            const net = new FakeNetwork([telekom, other]);
            const found = runSteps(net, discover(net, { upnp: true, natPmp: false, screen: refuseTelekom }));
            expect(found.identity?.manufacturer).toBe('AVM');
            expect(telekom.actions).toEqual([]);
        });
    });
});
