import type { Ipv4 } from './ipv4.ts';
import type { Steps } from './task.ts';

/** A transport protocol a port can be opened for. */
export type Protocol = 'tcp' | 'udp';

/** Which mechanism a gateway speaks. */
export type GatewayKind = 'upnp' | 'nat-pmp';

/** What to open on the router. */
export interface MappingRequest {
    protocol: Protocol;
    /** The port on this machine. */
    internalPort: number;
    /** The port to ask for on the router's public side. The router may give another one. */
    externalPort: number;
    /** Shown in the router's list of forwarded ports. */
    description: string;
    /** How long the router keeps the mapping without a renewal. 0 asks for one that doesn't expire. */
    leaseSeconds: number;
}

/** What the router agreed to. */
export interface MappingResult {
    externalPort: number;
    /** 0 when the mapping doesn't expire. */
    leaseSeconds: number;
}

/** The router refused the external port because something else already uses it. */
export class PortInUseError extends Error {}

/** A router that can open ports, reached through one protocol. */
export interface Gateway {
    readonly kind: GatewayKind;
    readonly address: Ipv4;
    /** The router's address on the internet side. */
    externalAddress(): Steps<Ipv4>;
    /**
     * Opens or renews a port.
     * @param internalClient - This machine's address on the router's network.
     * @throws {PortInUseError} When the external port is taken.
     */
    addMapping(request: MappingRequest, internalClient: Ipv4): Steps<MappingResult>;
    /** Closes a port. Closing one that isn't open is not an error. */
    deleteMapping(request: MappingRequest): Steps<void>;
}
