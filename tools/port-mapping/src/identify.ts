import { type HttpResponse, httpRequest } from './http.ts';
import type { Endpoint, Ipv4 } from './ipv4.ts';
import type { Network } from './network.ts';
import { parallel, type Steps } from './task.ts';

/** What is known about a router's make and model, and how it was found out. */
export interface RouterIdentity {
    /** The maker, for example `AVM Berlin` or `Telekom`. */
    manufacturer?: string;
    /** The model, for example `FRITZ!Box 7590`. */
    model?: string;
    /** The maker's own model number. */
    modelNumber?: string;
    /** What the router calls itself, for example `FRITZ!Box 7590 (UPnP/1.0)` or `Speedport`. */
    name?: string;
    /** `upnp`: from the UPnP device description. `web`: recognised by its web interface. */
    source: 'upnp' | 'web';
}

/** Decides whether a router may be used. Returns why not, or undefined when it may. */
export type Screen = (identity: RouterIdentity) => string | undefined;

/** A router was found and then turned down by the `screen` of the discovery. */
export class RouterRefusedError extends Error {
    /** Creates the error. */
    constructor(
        readonly reason: string,
        readonly identity: RouterIdentity
    ) {
        super(reason);
    }
}

/**
 * The router as a person would name it.
 * @returns For example `AVM FRITZ!Box 7590`, or `unknown router` when nothing is known.
 */
export function describeIdentity({ manufacturer, model, name }: RouterIdentity): string {
    const what = model ?? name;
    if (!manufacturer) return what ?? 'unknown router';
    if (!what) return manufacturer;
    return what.toLowerCase().includes(manufacturer.toLowerCase()) ? what : `${manufacturer} ${what}`;
}

/** A web page that gives away what a router is, for routers that don't speak UPnP. */
interface WebFingerprint {
    /** Where the page is. Redirects are not followed, so this is the page itself. */
    path: string;
    /** Recognises the router from the page. */
    identify(response: HttpResponse): RouterIdentity | undefined;
}

/**
 * Pages to recognise routers by. Add one for a router that cannot be told apart otherwise, which
 * means one that has no UPnP: the others describe themselves.
 */
const WEB_FINGERPRINTS: readonly WebFingerprint[] = [
    {
        // Telekom's login page is public. The model only shows after logging in, so it stays unknown.
        path: '/html/login/index.html',
        identify: ({ status, body }) =>
            status === 200 && /<title>\s*Speedport\b/i.test(body)
                ? { manufacturer: 'Telekom', name: 'Speedport', source: 'web' }
                : undefined
    }
];

/** How long a router's web page may take. Local routers answer at once; a missing one should not hold things up. */
const PROBE_TIMEOUT_MS = 1500;
const HTTP_PORT = 80;

/**
 * Recognises a router by its web interface, which is the only way when it answers no UPnP search.
 * @param addresses - Where the router may be. Usually its first or last address on the local network.
 * @returns The identity of the first address that gave itself away, or undefined.
 */
export function* probeWeb(net: Network, addresses: readonly Ipv4[]): Steps<RouterIdentity | undefined> {
    const probes = addresses.flatMap((address) =>
        WEB_FINGERPRINTS.map(function* (fingerprint): Steps<RouterIdentity | undefined> {
            const to: Endpoint = { address, port: HTTP_PORT };
            const response = yield* httpRequest(net, to, { method: 'GET', path: fingerprint.path }, PROBE_TIMEOUT_MS);
            return fingerprint.identify(response);
        })
    );
    const results = yield* parallel(probes);
    for (const result of results) if (result.ok && result.value) return result.value;
    return undefined;
}
