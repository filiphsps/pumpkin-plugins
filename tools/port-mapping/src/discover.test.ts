import { describe, expect, it } from 'vitest';
import { discover, search } from './discover.ts';
import { RouterRefusedError } from './identify.ts';
import type { Ipv4 } from './ipv4.ts';
import type { Datagram, DatagramSocket } from './network.ts';
import { SSDP_ADDRESS } from './ssdp.ts';
import { FakeIgd } from './testing/fake-igd.ts';
import { FakeNetwork, runSteps } from './testing/fake-network.ts';

const both = { upnp: true, natPmp: true };

class FloodNetwork extends FakeNetwork {
    readonly received: Datagram[] = [];
    closed = false;
    private readonly pending: Datagram[];

    constructor(datagrams: Datagram[]) {
        super();
        this.pending = datagrams;
    }

    override openDatagram(): DatagramSocket {
        return {
            close: () => {
                this.closed = true;
            },
            receive: () => {
                const datagram = this.pending.shift();
                if (datagram) this.received.push(datagram);
                return datagram;
            },
            send: () => {},
        };
    }

    get pendingCount(): number {
        return this.pending.length;
    }
}

function searchDatagrams(count: number): Datagram[] {
    return Array.from({ length: count }, (_, index) => {
        const host = index + 1;
        const address: Ipv4 = [192, 168, 1, host];
        return {
            data: new TextEncoder().encode(
                `HTTP/1.1 200 OK\r\nLOCATION: http://192.168.1.${host}:5000/root.xml\r\n\r\n`,
            ),
            from: { address, port: 1900 },
        };
    });
}

describe('SSDP search', () => {
    it('retains only the first five unique responses from a flood', () => {
        const net = new FloodNetwork(searchDatagrams(32));
        const steps = search(net, SSDP_ADDRESS, 3000);

        let result = steps.next();
        while (!result.done && net.pendingCount > 0) result = steps.next();
        net.time = 751;
        result = steps.next();

        expect(result).toEqual({
            done: true,
            value: [
                { location: 'http://192.168.1.1:5000/root.xml', responder: [192, 168, 1, 1] },
                { location: 'http://192.168.1.2:5000/root.xml', responder: [192, 168, 1, 2] },
                { location: 'http://192.168.1.3:5000/root.xml', responder: [192, 168, 1, 3] },
                { location: 'http://192.168.1.4:5000/root.xml', responder: [192, 168, 1, 4] },
                { location: 'http://192.168.1.5:5000/root.xml', responder: [192, 168, 1, 5] },
            ],
        });
        expect(net.closed).toBe(true);
    });

    it('reads answers whose lines end in a bare LF', () => {
        const data = new TextEncoder().encode('HTTP/1.1 200 OK\nLOCATION: http://192.168.1.1:5000/root.xml\n\n');
        const net = new FloodNetwork([{ data, from: { address: [192, 168, 1, 1], port: 1900 } }]);
        expect(runSteps(net, search(net, SSDP_ADDRESS, 3000))).toEqual([
            { location: 'http://192.168.1.1:5000/root.xml', responder: [192, 168, 1, 1] },
        ]);
    });

    it('yields after a bounded batch while flood datagrams remain queued', () => {
        const net = new FloodNetwork(searchDatagrams(100));
        const steps = search(net, SSDP_ADDRESS, 3000);

        expect(steps.next().done).toBe(false);
        expect(net.received).toHaveLength(16);
        expect(net.pendingCount).toBe(84);
        expect(() => steps.throw(new Error('stop search'))).toThrow('stop search');
        expect(net.closed).toBe(true);
    });
});

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
            'no router answered the search',
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

    it('honors an explicit NAT-PMP gateway and an explicit search address', () => {
        const igd = new FakeIgd({ address: [10, 9, 8, 7] });
        const net = new FakeNetwork([igd]);
        net.local = [192, 168, 1, 50];
        const found = runSteps(
            net,
            discover(net, { upnp: false, natPmp: true, natPmpGateway: { address: [10, 9, 8, 7], port: 5351 } }),
        );
        expect(found.gateway.address).toEqual([10, 9, 8, 7]);

        const upnp = runSteps(
            net,
            discover(net, { upnp: true, natPmp: false, ssdp: { address: [10, 9, 8, 7], port: 1900 } }),
        );
        expect(upnp.gateway.kind).toBe('upnp');
    });

    it('says why each protocol found nothing', () => {
        const net = new FakeNetwork([]);
        expect(() => runSteps(net, discover(net, both))).toThrow(
            'UPnP: no router answered the search; NAT-PMP: no answer from 192.168.1.1 or 192.168.1.254',
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

    it('reads device descriptions side by side, so silent devices do not add up', () => {
        const silent = [2, 3, 4, 5].map((last) => new FakeIgd({ address: [192, 168, 1, last], natPmp: false }));
        const net = new FakeNetwork([...silent, new FakeIgd({ natPmp: false })]);
        const dial = net.dial.bind(net);
        net.dial = (to) => (to.address[3] === 1 ? dial(to) : { poll: () => undefined, abort: () => {} });

        const found = runSteps(net, discover(net, { upnp: true, natPmp: false }));
        expect(found.gateway.address).toEqual([192, 168, 1, 1]);
        // One HTTP timeout is 5 s; reading the four silent devices one after another took 20 s.
        expect(net.time).toBeLessThan(10_000);
    });

    it('does not fetch a LOCATION hosted by a different device than the SSDP responder', () => {
        const responder = new FakeIgd({ natPmp: false });
        Object.defineProperty(responder, 'location', {
            get: () => 'http://192.168.1.2:6000/rootDesc.xml',
        });
        const otherDevice = new FakeIgd({ address: [192, 168, 1, 2], httpPort: 6000, natPmp: false });
        otherDevice.handleDatagram = () => [];
        const net = new FakeNetwork([responder, otherDevice]);

        expect(() => runSteps(net, discover(net, { upnp: true, natPmp: false }))).toThrow('no port mapping service');
        expect(net.connections).toHaveLength(0);
        expect(net.leaks).toBe(0);
    });

    it('skips a WAN service that has no internet address and uses the next one', () => {
        const igd = new FakeIgd({ natPmp: false });
        const service = (type: string, path: string) =>
            `<service><serviceType>urn:schemas-upnp-org:service:${type}</serviceType><controlURL>${path}</controlURL></service>`;
        const external = (address: string) =>
            `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:GetExternalIPAddressResponse xmlns:u="x"><NewExternalIPAddress>${address}</NewExternalIPAddress></u:GetExternalIPAddressResponse></s:Body></s:Envelope>`;
        igd.handleHttp = (method, path) => {
            if (method === 'GET')
                return {
                    status: 200,
                    body: `<root><device><serviceList>${service('WANIPConnection:1', '/ip')}${service('WANPPPConnection:1', '/ppp')}</serviceList></device></root>`,
                };
            return { status: 200, body: external(path === '/ip' ? '0.0.0.0' : '93.184.216.34') };
        };
        const net = new FakeNetwork([igd]);

        const found = runSteps(net, discover(net, { upnp: true, natPmp: false }));
        expect(found.externalAddress).toEqual([93, 184, 216, 34]);

        igd.handleHttp = (method) =>
            method === 'GET'
                ? {
                      status: 200,
                      body: `<root><device><serviceList>${service('WANIPConnection:1', '/ip')}</serviceList></device></root>`,
                  }
                : { status: 200, body: external('0.0.0.0') };
        expect(() => runSteps(net, discover(net, { upnp: true, natPmp: false }))).toThrow('no internet address');
    });

    it('accepts a private router whose HTTP services use a different port from SSDP', () => {
        const igd = new FakeIgd({ httpPort: 6000, natPmp: false });
        const net = new FakeNetwork([igd]);

        expect(runSteps(net, discover(net, { upnp: true, natPmp: false })).gateway.kind).toBe('upnp');
        expect(net.connections).toHaveLength(2);
        expect(net.leaks).toBe(0);
    });

    describe('with a screen', () => {
        const refuseTelekom = (identity: { manufacturer?: string }) =>
            identity.manufacturer?.includes('Telekom') ? 'no UPnP on Telekom' : undefined;
        const speedport = { '/html/login/index.html': { body: '<title>Speedport Konfigurationsprogramm</title>' } };

        it('names a router recognized by its web interface when no protocol finds a router', () => {
            const net = new FakeNetwork([new FakeIgd({ upnp: false, natPmp: false, webPages: speedport })]);
            let refusal: unknown;
            try {
                runSteps(net, discover(net, { ...both, screen: refuseTelekom }));
            } catch (err) {
                refusal = err;
            }
            expect(refusal).toBeInstanceOf(RouterRefusedError);
            expect(refusal).toMatchObject({ reason: 'no UPnP on Telekom', identity: { manufacturer: 'Telekom' } });
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

        it('does not let a recognized web page hide a router that answers', () => {
            const accessPoint = new FakeIgd({
                address: [192, 168, 1, 254],
                upnp: false,
                natPmp: false,
                webPages: speedport,
            });
            const net = new FakeNetwork([new FakeIgd(), accessPoint]);
            const found = runSteps(net, discover(net, { ...both, screen: refuseTelekom }));
            expect(found.gateway.kind).toBe('upnp');
            expect(found.gateway.address).toEqual([192, 168, 1, 1]);
            expect(net.leaks).toBe(0);
        });

        it('passes the identity of the router it lets through on', () => {
            const net = new FakeNetwork([
                new FakeIgd({ device: { manufacturer: 'AVM', modelName: 'FRITZ!Box 7590' } }),
            ]);
            const found = runSteps(net, discover(net, { ...both, screen: refuseTelekom }));
            expect(found.identity).toMatchObject({ manufacturer: 'AVM', model: 'FRITZ!Box 7590', source: 'upnp' });
        });

        it('uses a NAT-PMP router that answers, whatever its web interface says', () => {
            const net = new FakeNetwork([new FakeIgd({ upnp: false, webPages: speedport })]);
            const found = runSteps(net, discover(net, { ...both, screen: refuseTelekom }));
            expect(found.gateway.kind).toBe('nat-pmp');
            expect(found.identity).toBeUndefined();
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
