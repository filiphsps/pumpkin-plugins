import type { Gateway } from './gateway.ts';
import { httpRequest } from './http.ts';
import { probeWeb, type RouterIdentity, RouterRefusedError, type Screen } from './identify.ts';
import type { Endpoint, Ipv4 } from './ipv4.ts';
import { formatIpv4, sameIpv4 } from './ipv4.ts';
import { NAT_PMP_PORT, NatPmpGateway } from './natpmp.ts';
import type { Datagram, Network } from './network.ts';
import { parseSearchResponse, SEARCH_TARGETS, SSDP_ADDRESS, searchRequest } from './ssdp.ts';
import { parallel, type Steps } from './task.ts';
import { type ControlPoint, parseDescription, parseIdentity, UpnpGateway } from './upnp.ts';
import { parseHttpUrl } from './url.ts';

/** What to look for and where. */
export interface DiscoveryOptions {
    /** Look for NAT-PMP gateways. */
    natPmp: boolean;
    /** The NAT-PMP gateway to use. Without it the usual router addresses of the local network are tried. */
    natPmpGateway?: Endpoint;
    /**
     * Turns routers down by what they are. It sees every UPnP router that gives away its make and
     * model before anything is asked of it, and a router it gives a reason for is not used. When that
     * leaves no router, or no router answers and a web interface is recognized, discovery throws a
     * `RouterRefusedError`. Without it routers are not identified.
     */
    screen?: Screen;
    /** How long a UPnP search waits for answers, in milliseconds. */
    searchMs?: number;
    /** Where to send UPnP searches. Defaults to the SSDP multicast group; a router's own address works when multicast is blocked. */
    ssdp?: Endpoint;
    /** Look for UPnP gateways. */
    upnp: boolean;
}

/** A router that answered, and the address it has on the internet. */
export interface Discovered {
    externalAddress: Ipv4;
    gateway: Gateway;
    /** What is known about its make and model. */
    identity?: RouterIdentity;
}

/** A UPnP router that answered the search, and what it offers. */
interface UpnpCandidate {
    identity?: RouterIdentity;
    points: ControlPoint[];
}

/** An SSDP description URL and the device address that advertised it. */
interface UpnpResponse {
    location: string;
    responder: Ipv4;
}

/** How long to keep listening once the first router has answered, so slower ones can still be heard. */
const GRACE_MS = 750;
const MAX_LOCATIONS = 5;
const MAX_DATAGRAMS_PER_POLL = 16;

/**
 * Finds a router that can open ports. When both protocols are enabled, UPnP search and description
 * reads finish before NAT-PMP starts. Their protocol requests then run together, with UPnP preferred
 * when both answer.
 *
 * With a `screen`, UPnP descriptions are screened before any protocol request, and a rejected
 * router receives none. When no router answers either protocol, the web interface at the usual
 * router addresses is probed, so that a recognized router can be named as the reason.
 * @throws {RouterRefusedError} When the only routers found are turned down by the `screen`.
 * @throws {Error} Saying why each protocol found nothing.
 */
export function* discover(net: Network, options: DiscoveryOptions): Steps<Discovered> {
    if (!options.upnp && !options.natPmp) throw new Error('UPnP and NAT-PMP are both turned off');

    const jobs: { name: string; steps: Steps<Discovered> }[] = [];
    if (options.upnp) {
        try {
            const candidates = yield* surveyUpnp(net, options);
            jobs.push({ name: 'UPnP', steps: connectUpnp(net, candidates) });
        } catch (err) {
            if (err instanceof RouterRefusedError) throw err;
            jobs.push({ name: 'UPnP', steps: failWith(err) });
        }
    }
    if (options.natPmp) jobs.push({ name: 'NAT-PMP', steps: discoverNatPmp(net, options) });

    const results = yield* parallel(jobs.map((j) => j.steps));
    const found = results.find((r) => r.ok);
    if (found?.ok) return found.value;

    // Only now, so that a device at a usual router address cannot hide the router that answers.
    if (options.screen) {
        const identity = yield* probeWeb(net, gatewayAddresses(net, options));
        const reason = identity && options.screen(identity);
        if (identity && reason) throw new RouterRefusedError(reason, identity);
    }
    const reasons = results.map((r, i) => `${jobs[i]?.name}: ${r.ok ? '' : r.error.message}`);
    throw new Error(reasons.join('; '));
}

// biome-ignore lint/correctness/useYield: it only exists to fail like the other jobs do.
function* failWith(err: unknown): Steps<Discovered> {
    throw err instanceof Error ? err : new Error(String(err));
}

/** Searches for UPnP routers and reads what each says about itself, leaving out those the `screen` turns down. */
function* surveyUpnp(net: Network, options: DiscoveryOptions): Steps<UpnpCandidate[]> {
    const responses = yield* search(net, options.ssdp ?? SSDP_ADDRESS, options.searchMs ?? 3000);
    if (responses.length === 0) throw new Error('no router answered the search');

    const described = yield* parallel(responses.map((response) => describeSteps(net, response)));
    const candidates: UpnpCandidate[] = [];
    let refusal: RouterRefusedError | undefined;
    for (const result of described) {
        if (!result.ok) continue;
        const candidate = result.value;
        const reason = candidate.identity && options.screen?.(candidate.identity);
        if (candidate.identity && reason) refusal ??= new RouterRefusedError(reason, candidate.identity);
        else candidates.push(candidate);
    }
    if (candidates.length === 0 && refusal) throw refusal;
    return candidates;
}

function* connectUpnp(net: Network, candidates: readonly UpnpCandidate[]): Steps<Discovered> {
    let lastError = 'the routers found have no port mapping service';
    for (const { identity, points } of candidates) {
        for (const point of points) {
            try {
                const gateway = new UpnpGateway(net, point);
                const externalAddress = yield* gateway.externalAddress();
                // An idle WAN service answers 0.0.0.0 while another service of the router is online.
                if (externalAddress.every((octet) => octet === 0)) {
                    lastError = 'the router has no internet address on this connection';
                    continue;
                }
                return { gateway, externalAddress, identity };
            } catch (err) {
                lastError = err instanceof Error ? err.message : String(err);
            }
        }
    }
    throw new Error(lastError);
}

function* describeSteps(net: Network, { location, responder }: UpnpResponse): Steps<UpnpCandidate> {
    const url = parseHttpUrl(location);
    if (!url || !sameIpv4(url.endpoint.address, responder)) return { points: [] };
    try {
        const response = yield* httpRequest(net, url.endpoint, { method: 'GET', path: url.path });
        if (response.status !== 200) return { points: [] };
        return {
            points: parseDescription(response.body, location, responder),
            identity: parseIdentity(response.body),
        };
    } catch {
        return { points: [] };
    }
}

/**
 * Searches for UPnP responses and yields after each bounded receive batch.
 * @internal
 */
export function* search(net: Network, to: Endpoint, windowMs: number): Steps<UpnpResponse[]> {
    const socket = net.openDatagram();
    try {
        const start = net.now();
        const found = new Set<string>();
        const responses: UpnpResponse[] = [];
        let firstAt: number | undefined;
        let sends = 0;
        while (net.now() - start < windowMs && !(firstAt !== undefined && net.now() - firstAt > GRACE_MS)) {
            // UDP is lossy and routers are slow to wake, so ask twice.
            if (sends === 0 || (sends === 1 && net.now() - start >= 1000)) {
                for (const target of SEARCH_TARGETS) socket.send(to, searchRequest(target, to));
                sends++;
            }
            for (let i = 0; i < MAX_DATAGRAMS_PER_POLL; i++) {
                const datagram = socket.receive();
                if (!datagram) break;
                if (responses.length >= MAX_LOCATIONS) continue;
                const response = parseUpnpResponse(datagram);
                if (response) {
                    const key = `${formatIpv4(response.responder)}\0${response.location}`;
                    if (found.has(key)) continue;
                    found.add(key);
                    responses.push(response);
                    firstAt ??= net.now();
                }
            }
            yield;
        }
        return responses;
    } finally {
        socket.close();
    }
}

function parseUpnpResponse(datagram: Datagram): UpnpResponse | undefined {
    const location = parseSearchResponse(datagram.data);
    return location ? { location, responder: datagram.from.address } : undefined;
}

function* discoverNatPmp(net: Network, options: DiscoveryOptions): Steps<Discovered> {
    const candidates = natPmpCandidates(net, options);
    if (candidates.length === 0) throw new Error('this machine has no route to a local network');

    const results = yield* parallel(
        candidates.map(function* (to): Steps<Discovered> {
            const gateway = new NatPmpGateway(net, to.address, to.port);
            return { gateway, externalAddress: yield* gateway.externalAddress() };
        }),
    );
    const found = results.find((r) => r.ok);
    if (found?.ok) return found.value;
    throw new Error(`no answer from ${candidates.map((c) => formatIpv4(c.address)).join(' or ')}`);
}

/**
 * Where the router probably is: the gateway that was configured, or else the first and last
 * address of the local /24, which is where routers almost always are.
 */
function gatewayAddresses(net: Network, options: DiscoveryOptions): Ipv4[] {
    if (options.natPmpGateway) return [options.natPmpGateway.address];
    const local = net.localAddress();
    if (!local) return [];
    return [1, 254].map((last) => [local[0], local[1], local[2], last] as const);
}

function natPmpCandidates(net: Network, options: DiscoveryOptions): Endpoint[] {
    const port = options.natPmpGateway?.port ?? NAT_PMP_PORT;
    return gatewayAddresses(net, options).map((address) => ({ address, port }));
}
