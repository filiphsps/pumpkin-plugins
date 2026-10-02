/** Every permission Pumpkin 0.2.0 knows, from `crates/pumpkin/src/plugin/permissions.rs`. */
export const PUMPKIN_PERMISSIONS = [
    'network.dns',
    'network.tcp',
    'network.udp',
    'network.tcp.connect',
    'network.tcp.bind',
    'network.udp.connect',
    'network.udp.bind',
    'network.udp.outgoingdatagram',
    'network.loopback',
    'network.outbound',
    'http.outbound',
    'fs.read.data',
    'fs.write.data',
    'sys.env',
    'sys.info',
    'sys.info.cpu',
    'sys.info.ram',
    'sys.info.os'
] as const;

/** A permission name a plugin may request: a known one, or `sys.env.<NAME>` for a single environment variable. */
export type PumpkinPermission = (typeof PUMPKIN_PERMISSIONS)[number] | `sys.env.${string}`;

/**
 * Whether a string is a permission Pumpkin knows.
 * @param name - A permission name.
 */
export function isPumpkinPermission(name: string): name is PumpkinPermission {
    return (PUMPKIN_PERMISSIONS as readonly string[]).includes(name) || /^sys\.env\.\S+$/.test(name);
}
