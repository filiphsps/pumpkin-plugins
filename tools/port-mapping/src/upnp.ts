import { XMLParser } from 'fast-xml-parser';
import type { Gateway, MappingRequest, MappingResult } from './gateway.ts';
import { PortInUseError } from './gateway.ts';
import { httpRequest } from './http.ts';
import type { RouterIdentity } from './identify.ts';
import type { Endpoint, Ipv4 } from './ipv4.ts';
import { formatIpv4, parseIpv4 } from './ipv4.ts';
import type { Network } from './network.ts';
import type { Steps } from './task.ts';
import { parseHttpUrl, resolveUrl } from './url.ts';

/** A WAN connection service of a gateway: where to send its SOAP actions. */
export interface ControlPoint {
    /** For example `urn:schemas-upnp-org:service:WANIPConnection:1`. */
    serviceType: string;
    /** Absolute `http://` URL of the service's control endpoint. */
    controlUrl: string;
}

/** An error code a gateway answered a SOAP action with. */
export class UpnpError extends Error {
    /** Creates the error from the gateway's code and text. */
    constructor(
        readonly code: number,
        description: string
    ) {
        super(`${description || 'UPnP error'} (${code})`);
    }
}

const parser = new XMLParser({ removeNSPrefix: true, ignoreAttributes: true, parseTagValue: false });

const WAN_SERVICE = /^urn:schemas-upnp-org:service:WAN(?:IP|PPP)Connection:\d+$/;
const PERMANENT_LEASE_ONLY = 725;
const CONFLICT_CODES = new Set([718, 724, 727, 729]);

/** Service versions in the order to try them: IP connections first, newest first. */
const rank = (type: string) => (type.includes('WANIPConnection:2') ? 0 : type.includes('WANIPConnection') ? 1 : 2);

/**
 * Finds the WAN connection services in a device description.
 * @param xml - The description document.
 * @param location - The URL it was fetched from, for resolving relative control URLs.
 */
export function parseDescription(xml: string, location: string): ControlPoint[] {
    const root = parser.parse(xml) as { root?: { URLBase?: string; device?: unknown } };
    const base = typeof root.root?.URLBase === 'string' && root.root.URLBase ? root.root.URLBase : location;
    const found: ControlPoint[] = [];
    const walk = (node: unknown): void => {
        if (Array.isArray(node)) {
            for (const item of node) walk(item);
            return;
        }
        if (typeof node !== 'object' || node === null) return;
        for (const [key, value] of Object.entries(node)) {
            if (key === 'service') {
                for (const service of Array.isArray(value) ? value : [value]) {
                    const { serviceType, controlURL } = (service ?? {}) as {
                        serviceType?: string;
                        controlURL?: string;
                    };
                    if (serviceType && controlURL && WAN_SERVICE.test(serviceType))
                        found.push({ serviceType, controlUrl: resolveUrl(controlURL, base) });
                }
            } else {
                walk(value);
            }
        }
    };
    walk(root.root?.device);
    return found.sort((a, b) => rank(a.serviceType) - rank(b.serviceType));
}

/**
 * Reads the make and model a router gives in its device description.
 * @param xml - The description document.
 * @returns What the root device says about itself, or undefined when it says nothing.
 */
export function parseIdentity(xml: string): RouterIdentity | undefined {
    const root = parser.parse(xml) as { root?: { device?: Record<string, unknown> } };
    const device = root.root?.device;
    if (typeof device !== 'object' || device === null) return undefined;
    const field = (name: string) => {
        const value = device[name];
        return typeof value === 'string' && value.trim() ? value.trim() : undefined;
    };
    const identity: RouterIdentity = {
        manufacturer: field('manufacturer'),
        model: field('modelName'),
        modelNumber: field('modelNumber'),
        name: field('friendlyName'),
        source: 'upnp'
    };
    return identity.manufacturer || identity.model || identity.modelNumber || identity.name ? identity : undefined;
}

const escapeXml = (text: string) =>
    text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The SOAP envelope for one action. */
export function soapEnvelope(serviceType: string, action: string, args: [string, string | number][]): string {
    const body = args.map(([name, value]) => `<${name}>${escapeXml(String(value))}</${name}>`).join('');
    return (
        '<?xml version="1.0"?>' +
        '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
        `<s:Body><u:${action} xmlns:u="${serviceType}">${body}</u:${action}></s:Body></s:Envelope>`
    );
}

/**
 * Reads a SOAP answer.
 * @returns The fields of the response, by name.
 * @throws {UpnpError} When the answer is a fault.
 */
export function parseSoapResponse(xml: string): Record<string, string> {
    const envelope = (parser.parse(xml) as { Envelope?: { Body?: Record<string, unknown> } }).Envelope;
    const body = envelope?.Body ?? {};
    const fault = body.Fault as
        | { detail?: { UPnPError?: { errorCode?: string; errorDescription?: string } } }
        | undefined;
    if (fault) {
        const detail = fault.detail?.UPnPError;
        throw new UpnpError(Number(detail?.errorCode ?? 0), detail?.errorDescription ?? 'the router reported an error');
    }
    const response = Object.values(body)[0];
    const fields: Record<string, string> = {};
    if (typeof response === 'object' && response !== null)
        for (const [name, value] of Object.entries(response)) fields[name] = String(value);
    return fields;
}

/** A router reached with UPnP IGD. */
export class UpnpGateway implements Gateway {
    readonly kind = 'upnp';
    readonly address: Ipv4;
    private readonly target: Endpoint;
    private readonly path: string;

    /**
     * Creates a gateway for one control point.
     * @throws {Error} When the control URL isn't an `http://` URL with an IPv4 host.
     */
    constructor(
        private readonly net: Network,
        private readonly control: ControlPoint
    ) {
        const url = parseHttpUrl(control.controlUrl);
        if (!url) throw new Error(`cannot use the control URL ${control.controlUrl}`);
        this.target = url.endpoint;
        this.path = url.path;
        this.address = url.endpoint.address;
    }

    /** {@inheritDoc Gateway.externalAddress} */
    *externalAddress(): Steps<Ipv4> {
        const fields = yield* this.action('GetExternalIPAddress', []);
        const address = parseIpv4(fields.NewExternalIPAddress ?? '');
        if (!address) throw new Error('the router did not say its external address');
        return address;
    }

    /** {@inheritDoc Gateway.addMapping} */
    *addMapping(request: MappingRequest, internalClient: Ipv4): Steps<MappingResult> {
        let lease = request.leaseSeconds;
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                yield* this.action('AddPortMapping', [
                    ['NewRemoteHost', ''],
                    ['NewExternalPort', request.externalPort],
                    ['NewProtocol', request.protocol.toUpperCase()],
                    ['NewInternalPort', request.internalPort],
                    ['NewInternalClient', formatIpv4(internalClient)],
                    ['NewEnabled', 1],
                    ['NewPortMappingDescription', request.description],
                    ['NewLeaseDuration', lease]
                ]);
                return { externalPort: request.externalPort, leaseSeconds: lease };
            } catch (err) {
                if (err instanceof UpnpError && err.code === PERMANENT_LEASE_ONLY && lease !== 0) {
                    lease = 0;
                    continue;
                }
                if (err instanceof UpnpError && CONFLICT_CODES.has(err.code)) throw new PortInUseError(err.message);
                throw err;
            }
        }
        throw new Error('the router refused the mapping');
    }

    /** {@inheritDoc Gateway.deleteMapping} */
    *deleteMapping(request: MappingRequest): Steps<void> {
        try {
            yield* this.action('DeletePortMapping', [
                ['NewRemoteHost', ''],
                ['NewExternalPort', request.externalPort],
                ['NewProtocol', request.protocol.toUpperCase()]
            ]);
        } catch (err) {
            // 714: there was no such mapping, which is what we wanted.
            if (!(err instanceof UpnpError && err.code === 714)) throw err;
        }
    }

    private *action(name: string, args: [string, string | number][]): Steps<Record<string, string>> {
        const response = yield* httpRequest(this.net, this.target, {
            method: 'POST',
            path: this.path,
            headers: {
                'Content-Type': 'text/xml; charset="utf-8"',
                SOAPAction: `"${this.control.serviceType}#${name}"`
            },
            body: soapEnvelope(this.control.serviceType, name, args)
        });
        if (response.status !== 200 && response.status !== 500)
            throw new Error(`the router answered ${response.status}`);
        return parseSoapResponse(response.body);
    }
}
