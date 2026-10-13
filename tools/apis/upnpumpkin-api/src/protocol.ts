import { strFromU8, strToU8 } from 'fflate';

/** The name UPnPumpkin registers with Pumpkin, which is what other plugins send their messages to. */
export const UPNPUMPKIN_PLUGIN = 'UPnPumpkin';

/** Version of the message format. A plugin that sends another version is told so and nothing else happens. */
export const PROTOCOL_VERSION = 1;

/** A port a plugin wants reachable from the internet. */
export interface PortRequest {
    /** Names the request within the asking plugin. UPnPumpkin keeps the plugins' keys apart. */
    key: string;
    protocol: 'tcp' | 'udp';
    /** The port on this machine. */
    port: number;
    /** The public port to ask for. Defaults to `port`; the router may give another one. */
    externalPort?: number;
    /** Shown in the router's list of forwarded ports. */
    description: string;
}

/** Whether a port is reachable yet, and where. */
export type PortStatus =
    | { kind: 'pending' }
    | {
          kind: 'open';
          /** How: `public` means this machine already has a public address and nothing had to be opened. */
          via: 'public' | 'upnp' | 'nat-pmp';
          /** Public IPv4 address. */
          address: string;
          /** Public port. */
          port: number;
      }
    | { kind: 'failed'; reason: string }
    | { kind: 'unknown' };

/** What UPnPumpkin knows about the network. */
export interface NetworkInfo {
    /** This machine's address toward the internet. */
    localAddress?: string;
    /** The router that opens ports. */
    gateway?: { kind: 'upnp' | 'nat-pmp'; address: string };
    /** The router's address on the internet side. */
    externalAddress?: string;
}

/** A message to UPnPumpkin. */
export type Request =
    | ({ op: 'ensure' } & PortRequest)
    | { op: 'status'; key: string }
    | { op: 'release'; key: string }
    | { op: 'info' };

/** UPnPumpkin's answer. */
export type Reply = { ok: true; status?: PortStatus; info?: NetworkInfo } | { ok: false; error: string };

const MAX_KEY = 64;
const MAX_DESCRIPTION = 100;

const isPort = (value: unknown): value is number =>
    Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 65535;
const isText = (value: unknown, max: number): value is string =>
    typeof value === 'string' && value.length > 0 && value.length <= max;

/** Writes a request as the bytes of an IPC message. */
export function encodeRequest(request: Request): Uint8Array {
    return strToU8(JSON.stringify({ v: PROTOCOL_VERSION, ...request }));
}

/** Writes a reply as the bytes of an IPC message. */
export function encodeReply(reply: Reply): Uint8Array {
    return strToU8(JSON.stringify({ v: PROTOCOL_VERSION, ...reply }));
}

/**
 * Reads a request, checking every field because it comes from another plugin.
 * @returns The request, or an error text fit for sending back.
 */
export function decodeRequest(bytes: Uint8Array): { request: Request } | { error: string } {
    let value: Record<string, unknown>;
    try {
        value = JSON.parse(strFromU8(bytes)) as Record<string, unknown>;
    } catch {
        return { error: 'the message is not JSON' };
    }
    if (typeof value !== 'object' || value === null) return { error: 'the message is not an object' };
    if (value.v !== PROTOCOL_VERSION)
        return { error: `unsupported protocol version ${String(value.v)}, expected ${PROTOCOL_VERSION}` };

    switch (value.op) {
        case 'info':
            return { request: { op: 'info' } };
        case 'status':
        case 'release':
            if (!isText(value.key, MAX_KEY)) return { error: 'key must be a short non-empty string' };
            return { request: { op: value.op, key: value.key } };
        case 'ensure': {
            if (!isText(value.key, MAX_KEY)) return { error: 'key must be a short non-empty string' };
            if (value.protocol !== 'tcp' && value.protocol !== 'udp')
                return { error: 'protocol must be "tcp" or "udp"' };
            if (!isPort(value.port)) return { error: 'port must be a number from 1 to 65535' };
            if (value.externalPort !== undefined && !isPort(value.externalPort))
                return { error: 'externalPort must be a number from 1 to 65535' };
            if (!isText(value.description, MAX_DESCRIPTION))
                return { error: 'description must be a short non-empty string' };
            return {
                request: {
                    op: 'ensure',
                    key: value.key,
                    protocol: value.protocol,
                    port: value.port,
                    externalPort: value.externalPort as number | undefined,
                    description: value.description
                }
            };
        }
        default:
            return { error: `unknown operation ${String(value.op)}` };
    }
}

/**
 * Reads a reply.
 * @returns The reply, or undefined when the bytes aren't one this version understands.
 */
export function decodeReply(bytes: Uint8Array): Reply | undefined {
    try {
        const value = JSON.parse(strFromU8(bytes)) as Record<string, unknown>;
        if (value.v !== PROTOCOL_VERSION || typeof value.ok !== 'boolean') return undefined;
        if (!value.ok) return { ok: false, error: typeof value.error === 'string' ? value.error : 'unknown error' };
        return {
            ok: true,
            status: value.status as PortStatus | undefined,
            info: value.info as NetworkInfo | undefined
        };
    } catch {
        return undefined;
    }
}
