import { strFromU8, strToU8 } from 'fflate';
import { type Endpoint, formatIpv4, type Ipv4, sameIpv4 } from '../ipv4.ts';
import { NAT_PMP_PORT } from '../natpmp.ts';

/** A port mapping a `FakeIgd` holds. */
export interface FakeMapping {
    protocol: 'tcp' | 'udp';
    externalPort: number;
    internalPort: number;
    client: string;
    description: string;
    leaseSeconds: number;
}

/** How a `FakeIgd` behaves. */
export interface FakeIgdOptions {
    /** The router's address on the local network. */
    address?: Ipv4;
    /** The router's address on the internet side. */
    externalAddress?: Ipv4;
    /** Port of the router's HTTP server. */
    httpPort?: number;
    /** Answer UPnP searches and actions. */
    upnp?: boolean;
    /** Answer NAT-PMP requests. */
    natPmp?: boolean;
    /** Refuse mappings that expire, as some routers do. */
    permanentLeasesOnly?: boolean;
    /** External ports that are already in use. */
    takenPorts?: number[];
    /** Make every AddPortMapping fail with this UPnP error code. */
    failMappingWith?: number;
    /** What the UPnP device description says about the router. */
    device?: { manufacturer?: string; modelName?: string; modelNumber?: string; friendlyName?: string };
    /** Pages of the router's web interface on port 80, by path. They are served even when UPnP is off. */
    webPages?: Record<string, { status?: number; body: string }>;
}

const SERVICE = 'urn:schemas-upnp-org:service:WANIPConnection:1';
const CONTROL_PATH = '/ctl/IPConn';
const DESCRIPTION_PATH = '/rootDesc.xml';

/** A router that speaks UPnP IGD and NAT-PMP, in memory, for tests. It knows nothing about sockets. */
export class FakeIgd {
    readonly address: Ipv4;
    readonly httpPort: number;
    readonly mappings = new Map<string, FakeMapping>();
    readonly actions: string[] = [];
    readonly options: Required<Omit<FakeIgdOptions, 'failMappingWith' | 'device'>> &
        Pick<FakeIgdOptions, 'failMappingWith' | 'device'>;

    /** Creates a router. Everything is on by default. */
    constructor(options: FakeIgdOptions = {}) {
        this.options = {
            address: [192, 168, 1, 1],
            externalAddress: [93, 184, 216, 34],
            httpPort: 5000,
            upnp: true,
            natPmp: true,
            permanentLeasesOnly: false,
            takenPorts: [],
            webPages: {},
            ...options
        };
        this.address = this.options.address;
        this.httpPort = this.options.httpPort;
    }

    /** The `LOCATION` of this router's description document. */
    get location(): string {
        return `http://${formatIpv4(this.address)}:${this.httpPort}${DESCRIPTION_PATH}`;
    }

    /**
     * Handles a UDP datagram sent to the router (or to the multicast group).
     * @returns The datagrams the router sends back.
     */
    handleDatagram(to: Endpoint, data: Uint8Array): Uint8Array[] {
        if (to.port === 1900 && this.options.upnp) return this.searchReply(data);
        if (to.port === NAT_PMP_PORT && sameIpv4(to.address, this.address) && this.options.natPmp)
            return this.natPmp(data);
        return [];
    }

    /** Handles an HTTP request to the router's server. */
    handleHttp(
        method: string,
        path: string,
        headers: Record<string, string>,
        body: string
    ): { status: number; body: string } {
        const page = method === 'GET' ? this.options.webPages[path] : undefined;
        if (page) return { status: page.status ?? 200, body: page.body };
        if (!this.options.upnp) return { status: 404, body: '' };
        if (method === 'GET' && path === DESCRIPTION_PATH) return { status: 200, body: this.description() };
        if (method === 'POST' && path === CONTROL_PATH) return this.soap(headers.soapaction ?? '', body);
        return { status: 404, body: '' };
    }

    private searchReply(data: Uint8Array): Uint8Array[] {
        const text = strFromU8(data);
        if (!text.startsWith('M-SEARCH')) return [];
        const target = /^ST:\s*(.+)$/im.exec(text)?.[1]?.trim() ?? '';
        const answers =
            target === 'ssdp:all' || target.includes('InternetGatewayDevice:1') || target.includes('WANIPConnection:1');
        if (!answers) return [];
        return [
            strToU8(
                `HTTP/1.1 200 OK\r\nCACHE-CONTROL: max-age=120\r\nST: ${target}\r\nUSN: uuid:fake::${target}\r\nLOCATION: ${this.location}\r\n\r\n`
            )
        ];
    }

    /** Whether the router has a web interface for `FakeNetwork` to connect to on port 80. */
    get hasWebInterface(): boolean {
        return Object.keys(this.options.webPages).length > 0;
    }

    private description(): string {
        const { manufacturer, modelName, modelNumber, friendlyName } = this.options.device ?? {};
        const tag = (name: string, value: string | undefined) =>
            value === undefined ? '' : `<${name}>${value}</${name}>`;
        return (
            '<?xml version="1.0"?><root xmlns="urn:schemas-upnp-org:device-1-0"><specVersion><major>1</major><minor>0</minor></specVersion>' +
            '<device><deviceType>urn:schemas-upnp-org:device:InternetGatewayDevice:1</deviceType>' +
            tag('friendlyName', friendlyName) +
            tag('manufacturer', manufacturer) +
            tag('modelName', modelName) +
            tag('modelNumber', modelNumber) +
            '<deviceList>' +
            '<device><deviceType>urn:schemas-upnp-org:device:WANDevice:1</deviceType><deviceList>' +
            '<device><deviceType>urn:schemas-upnp-org:device:WANConnectionDevice:1</deviceType><serviceList>' +
            `<service><serviceType>${SERVICE}</serviceType><serviceId>urn:upnp-org:serviceId:WANIPConn1</serviceId><controlURL>${CONTROL_PATH}</controlURL></service>` +
            '</serviceList></device></deviceList></device></deviceList></device></root>'
        );
    }

    private soap(action: string, body: string): { status: number; body: string } {
        const name = /#(\w+)"?$/.exec(action)?.[1] ?? '';
        const arg = (field: string) => new RegExp(`<${field}>([^<]*)</${field}>`).exec(body)?.[1] ?? '';
        this.actions.push(name);
        const ok = (inner = '') => ({
            status: 200,
            body: `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:${name}Response xmlns:u="${SERVICE}">${inner}</u:${name}Response></s:Body></s:Envelope>`
        });
        const fail = (code: number, text: string) => ({
            status: 500,
            body: `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring><detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0"><errorCode>${code}</errorCode><errorDescription>${text}</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>`
        });

        if (name === 'GetExternalIPAddress')
            return ok(`<NewExternalIPAddress>${formatIpv4(this.options.externalAddress)}</NewExternalIPAddress>`);
        if (name === 'AddPortMapping') {
            const lease = Number(arg('NewLeaseDuration'));
            const externalPort = Number(arg('NewExternalPort'));
            if (this.options.failMappingWith) return fail(this.options.failMappingWith, 'Action Failed');
            if (this.options.permanentLeasesOnly && lease !== 0) return fail(725, 'OnlyPermanentLeasesSupported');
            if (this.options.takenPorts.includes(externalPort)) return fail(718, 'ConflictInMappingEntry');
            const protocol = arg('NewProtocol').toLowerCase() as 'tcp' | 'udp';
            this.mappings.set(`${protocol}:${externalPort}`, {
                protocol,
                externalPort,
                internalPort: Number(arg('NewInternalPort')),
                client: arg('NewInternalClient'),
                description: arg('NewPortMappingDescription'),
                leaseSeconds: lease
            });
            return ok();
        }
        if (name === 'DeletePortMapping') {
            const key = `${arg('NewProtocol').toLowerCase()}:${arg('NewExternalPort')}`;
            return this.mappings.delete(key) ? ok() : fail(714, 'NoSuchEntryInArray');
        }
        return fail(401, 'Invalid Action');
    }

    private natPmp(data: Uint8Array): Uint8Array[] {
        const external = this.options.externalAddress;
        if (data.length === 2 && data[0] === 0 && data[1] === 0) {
            return [Uint8Array.of(0, 128, 0, 0, 0, 0, 0, 1, external[0], external[1], external[2], external[3])];
        }
        if (data.length !== 12 || data[0] !== 0 || (data[1] !== 1 && data[1] !== 2)) return [];
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const protocol = data[1] === 1 ? 'udp' : 'tcp';
        const internalPort = view.getUint16(4);
        let externalPort = view.getUint16(6);
        const lifetime = view.getUint32(8);
        if (lifetime === 0) {
            for (const [key, m] of this.mappings)
                if (m.protocol === protocol && m.internalPort === internalPort) this.mappings.delete(key);
            externalPort = 0;
        } else {
            while (this.options.takenPorts.includes(externalPort) || externalPort === 0)
                externalPort = (externalPort % 60000) + 1025;
            this.mappings.set(`${protocol}:${externalPort}`, {
                protocol,
                externalPort,
                internalPort,
                client: 'nat-pmp',
                description: '',
                leaseSeconds: lifetime
            });
        }
        const reply = new Uint8Array(16);
        const out = new DataView(reply.buffer);
        reply[1] = 128 + data[1];
        out.setUint16(8, internalPort);
        out.setUint16(10, externalPort);
        out.setUint32(12, lifetime);
        return [reply];
    }
}
