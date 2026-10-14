import { describe, expect, it } from 'vitest';
import { FakeIgd } from './testing/fake-igd.ts';
import { FakeNetwork, runSteps } from './testing/fake-network.ts';
import { parseDescription, parseIdentity, parseSoapResponse, soapEnvelope, UpnpError, UpnpGateway } from './upnp.ts';

describe('parseIdentity', () => {
    it('reads the make and model of the root device', () => {
        const device = {
            manufacturer: 'AVM Berlin',
            modelName: 'FRITZ!Box 7590',
            modelNumber: 'avme',
            friendlyName: 'FRITZ!Box 7590',
        };
        const xml = new FakeIgd({ device }).handleHttp('GET', '/rootDesc.xml', {}, '').body;
        expect(parseIdentity(xml)).toEqual({
            manufacturer: 'AVM Berlin',
            model: 'FRITZ!Box 7590',
            modelNumber: 'avme',
            name: 'FRITZ!Box 7590',
            source: 'upnp',
        });
    });

    it('is undefined when the device says nothing about itself or the document is not a description', () => {
        expect(parseIdentity(new FakeIgd().handleHttp('GET', '/rootDesc.xml', {}, '').body)).toBeUndefined();
        expect(parseIdentity('<root><device><manufacturer>  </manufacturer></device></root>')).toBeUndefined();
        expect(parseIdentity('not xml')).toBeUndefined();
    });
});

describe('parseDescription', () => {
    const location = 'http://192.168.1.1:5000/rootDesc.xml';

    it('finds the WAN connection service nested in the device tree', () => {
        const xml = new FakeIgd().handleHttp('GET', '/rootDesc.xml', {}, '').body;
        expect(parseDescription(xml, location)).toEqual([
            {
                serviceType: 'urn:schemas-upnp-org:service:WANIPConnection:1',
                controlUrl: 'http://192.168.1.1:5000/ctl/IPConn',
            },
        ]);
    });

    it('prefers IP connections over PPP and newer over older, and honors URLBase', () => {
        const service = (type: string, url: string) =>
            `<service><serviceType>urn:schemas-upnp-org:service:${type}</serviceType><controlURL>${url}</controlURL></service>`;
        const xml = `<root><URLBase>http://10.0.0.1:49000/</URLBase><device><serviceList>${service('WANPPPConnection:1', '/ppp')}${service('Layer3Forwarding:1', '/l3')}${service('WANIPConnection:1', '/ip1')}${service('WANIPConnection:2', '/ip2')}</serviceList></device></root>`;
        expect(parseDescription(xml, location).map((c) => c.controlUrl)).toEqual([
            'http://10.0.0.1:49000/ip2',
            'http://10.0.0.1:49000/ip1',
            'http://10.0.0.1:49000/ppp',
        ]);
    });

    it('returns nothing for documents without a WAN service', () => {
        expect(parseDescription('<root><device><serviceList></serviceList></device></root>', location)).toEqual([]);
        expect(parseDescription('not xml', location)).toEqual([]);
    });
});

describe('SOAP', () => {
    it('builds an envelope and escapes the arguments', () => {
        const xml = soapEnvelope('urn:x:service:S:1', 'Act', [
            ['NewDescription', 'a <b> & "c"'],
            ['NewPort', 80],
        ]);
        expect(xml).toContain('<u:Act xmlns:u="urn:x:service:S:1">');
        expect(xml).toContain('<NewDescription>a &lt;b&gt; &amp; &quot;c&quot;</NewDescription><NewPort>80</NewPort>');
    });

    const envelope = (body: string, prefix = 's') =>
        `<${prefix}:Envelope xmlns:${prefix}="http://schemas.xmlsoap.org/soap/envelope/"><${prefix}:Body>${body}</${prefix}:Body></${prefix}:Envelope>`;

    it.each([
        ['empty body', 200, ''],
        ['malformed XML', 200, envelope('<u:AddPortMappingResponse xmlns:u="x">')],
        ['missing envelope', 200, '<Body><AddPortMappingResponse/></Body>'],
        ['missing body', 200, '<Envelope><AddPortMappingResponse/></Envelope>'],
        ['unrelated action', 200, envelope('<u:DeletePortMappingResponse xmlns:u="x"/>')],
        ['unrecognized failure', 500, envelope('<u:AddPortMappingResponse xmlns:u="x"/>')],
        ['unrecognized fault', 500, envelope('<Fault><faultstring>Failed</faultstring></Fault>')],
    ])('rejects %s rather than recording mapping success', (_name, status, body) => {
        const igd = new FakeIgd();
        igd.handleHttp = () => ({ status: Number(status), body: String(body) });
        const net = new FakeNetwork([igd]);
        const gateway = new UpnpGateway(net, { serviceType: 'urn:x:service:S:1', controlUrl: igd.location });
        expect(() =>
            runSteps(
                net,
                gateway.addMapping(
                    {
                        protocol: 'tcp',
                        internalPort: 8123,
                        externalPort: 8123,
                        description: 'Packs',
                        leaseSeconds: 3600,
                    },
                    [192, 168, 1, 50],
                ),
            ),
        ).toThrow();
        expect(net.leaks).toBe(0);
    });

    it.each(['s', 'soap'])('accepts a valid empty action element with the %s prefix', (prefix) => {
        const igd = new FakeIgd();
        igd.handleHttp = () => ({ status: 200, body: envelope('<u:AddPortMappingResponse xmlns:u="x"/>', prefix) });
        const net = new FakeNetwork([igd]);
        const gateway = new UpnpGateway(net, { serviceType: 'urn:x:service:S:1', controlUrl: igd.location });
        expect(
            runSteps(
                net,
                gateway.addMapping(
                    {
                        protocol: 'tcp',
                        internalPort: 8123,
                        externalPort: 8123,
                        description: 'Packs',
                        leaseSeconds: 3600,
                    },
                    [192, 168, 1, 50],
                ),
            ),
        ).toEqual({ externalPort: 8123, leaseSeconds: 3600 });
        expect(net.leaks).toBe(0);
    });

    it('reads response fields and turns faults into UpnpError', () => {
        const ok =
            '<s:Envelope xmlns:s="x"><s:Body><u:GetExternalIPAddressResponse xmlns:u="y"><NewExternalIPAddress>1.2.3.4</NewExternalIPAddress></u:GetExternalIPAddressResponse></s:Body></s:Envelope>';
        expect(parseSoapResponse(ok, 'GetExternalIPAddress')).toEqual({ NewExternalIPAddress: '1.2.3.4' });
        const fault = new FakeIgd({ failMappingWith: 501 }).handleHttp(
            'POST',
            '/ctl/IPConn',
            { soapaction: '"x#AddPortMapping"' },
            '',
        ).body;
        expect(() => parseSoapResponse(fault, 'AddPortMapping', 500)).toThrow(UpnpError);
        expect(() => parseSoapResponse(fault, 'AddPortMapping', 500)).toThrow('(501)');
    });
});
