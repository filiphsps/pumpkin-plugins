import { strFromU8, strToU8 } from 'fflate';

/** The name UPnPumpkin registers with Pumpkin, which is what other plugins send their messages to. */
export const UPNPUMPKIN_PLUGIN = 'UPnPumpkin';

/** Version of the message format. A plugin that sends another version is told so and nothing else happens. */
export const PROTOCOL_VERSION = 1;

/** A port a plugin wants reachable from the internet. */
export interface PortRequest {
    /** Shown in the router's list of forwarded ports. */
    description: string;
    /** The public port to ask for. Defaults to `port`; the router may give another one. */
    externalPort?: number;
    /** Names the request within the asking plugin. UPnPumpkin keeps the plugins' keys apart. */
    key: string;
    /** The port on this machine. */
    port: number;
    protocol: 'tcp' | 'udp';
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
    /** The router's address on the internet side. */
    externalAddress?: string;
    /** The router that opens ports. */
    gateway?: { kind: 'upnp' | 'nat-pmp'; address: string };
    /** This machine's address toward the internet. */
    localAddress?: string;
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
    typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535;
// C0 and C1 controls and the Unicode line breaks: they would forge server log lines, and most of
// them are not allowed in the XML sent to a UPnP router.
const isControl = (character: string) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
};
const isText = (value: unknown, max: number): value is string =>
    typeof value === 'string' && value.length > 0 && value.length <= max && ![...value].some(isControl);
const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const isPortStatus = (value: unknown): value is PortStatus => {
    if (!isRecord(value)) return false;

    switch (value.kind) {
        case 'pending':
        case 'unknown':
            return true;
        case 'open':
            return (
                (value.via === 'public' || value.via === 'upnp' || value.via === 'nat-pmp') &&
                typeof value.address === 'string' &&
                isPort(value.port)
            );
        case 'failed':
            return typeof value.reason === 'string';
        default:
            return false;
    }
};

const isNetworkInfo = (value: unknown): value is NetworkInfo => {
    if (!isRecord(value)) return false;
    if (value.externalAddress !== undefined && typeof value.externalAddress !== 'string') return false;
    if (value.localAddress !== undefined && typeof value.localAddress !== 'string') return false;

    const gateway = value.gateway;
    return (
        gateway === undefined ||
        (isRecord(gateway) &&
            (gateway.kind === 'upnp' || gateway.kind === 'nat-pmp') &&
            typeof gateway.address === 'string')
    );
};

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
            if (!isText(value.key, MAX_KEY))
                return { error: 'key must be a short non-empty string without control characters' };
            return { request: { op: value.op, key: value.key } };
        case 'ensure': {
            if (!isText(value.key, MAX_KEY))
                return { error: 'key must be a short non-empty string without control characters' };
            if (value.protocol !== 'tcp' && value.protocol !== 'udp')
                return { error: 'protocol must be "tcp" or "udp"' };
            if (!isPort(value.port)) return { error: 'port must be a number from 1 to 65535' };
            if (value.externalPort !== undefined && !isPort(value.externalPort))
                return { error: 'externalPort must be a number from 1 to 65535' };
            if (!isText(value.description, MAX_DESCRIPTION))
                return { error: 'description must be a short non-empty string without control characters' };
            return {
                request: {
                    op: 'ensure',
                    key: value.key,
                    protocol: value.protocol,
                    port: value.port,
                    externalPort: value.externalPort as number | undefined,
                    description: value.description,
                },
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
        const value: unknown = JSON.parse(strFromU8(bytes));
        if (!isRecord(value) || value.v !== PROTOCOL_VERSION || typeof value.ok !== 'boolean') return undefined;
        if (!value.ok) return { ok: false, error: typeof value.error === 'string' ? value.error : 'unknown error' };

        const status = value.status;
        const info = value.info;
        if (status !== undefined && !isPortStatus(status)) return undefined;
        if (info !== undefined && !isNetworkInfo(info)) return undefined;

        return {
            ok: true,
            status,
            info,
        };
    } catch {
        return undefined;
    }
}
