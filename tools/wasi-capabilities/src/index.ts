/** The WASI version plugins import. The server's runtime provides it; it must not be newer than the server's. */
export const WASI_VERSION = '0.2.3';

/**
 * Import specifiers the builder leaves out of plugin bundles. The Pumpkin runtime provides these
 * modules, so tools that follow a plugin's imports stop at them too.
 */
export const EXTERNAL_MODULES = ['pumpkin:plugin/*', 'wasi:*'] as const;

/** WASI interfaces a plugin can opt into, by the name used in `pumpkinPlugin.wasi`. */
export const CAPABILITIES = {
    http: ['http/types', 'http/outgoing-handler'],
    filesystem: ['filesystem/types', 'filesystem/preopens'],
    sockets: ['sockets/network', 'sockets/instance-network', 'sockets/tcp', 'sockets/tcp-create-socket'],
    udp: ['sockets/network', 'sockets/instance-network', 'sockets/udp', 'sockets/udp-create-socket'],
} as const;

/** A name accepted in `pumpkinPlugin.wasi`. */
export type Capability = keyof typeof CAPABILITIES;

/** Interfaces every capability needs: pollables, streams and clocks. */
const SUPPORT_IMPORTS = ['io/poll', 'io/streams', 'clocks/monotonic-clock'];

/**
 * Whether a string names a capability.
 * @param name - A value from `pumpkinPlugin.wasi`.
 * @returns True for known capabilities.
 */
export function isCapability(name: string): name is Capability {
    return Object.hasOwn(CAPABILITIES, name);
}

/**
 * The WASI interfaces a set of capabilities needs.
 * @param capabilities - What the plugin opted into.
 * @returns Interfaces as `package/interface`, without duplicates. Empty when nothing was requested.
 */
export function wasiInterfaces(capabilities: readonly Capability[]): string[] {
    if (capabilities.length === 0) return [];
    return [...new Set([...capabilities.flatMap((c) => CAPABILITIES[c]), ...SUPPORT_IMPORTS])];
}

/**
 * Returns every capability that imports an interface, including shared support interfaces.
 * @param interfacePath - Exact `package/interface` path, without the `wasi:` prefix or version.
 * @returns Matching names in declaration order; an empty array for unknown paths. Only a single match is unambiguous.
 */
export function capabilitiesForInterface(interfacePath: string): Capability[] {
    return (Object.keys(CAPABILITIES) as Capability[]).filter((capability) =>
        wasiInterfaces([capability]).includes(interfacePath),
    );
}
