import { type Field, field, str, tomlString } from '@pumpkin-plugins/config';
import { parseIpv4 } from '@pumpkin-plugins/port-mapping/ipv4';

/** An `address:port` setting with an IPv4 address, or empty when allowed. */
export function ipv4Endpoint(options: { description: string; default: string; example?: string }): Field<string> {
    return str({
        ...options,
        check: {
            expected: 'an IPv4 address and port like "192.168.1.1:5351", or ""',
            test: (v) => v === '' || parseEndpoint(v) !== undefined,
        },
    });
}

/**
 * Reads `address:port`.
 * @returns The address and port, or undefined when the text isn't one.
 */
export function parseEndpoint(text: string): { address: [number, number, number, number]; port: number } | undefined {
    const match = /^([^:]+):(\d{1,5})$/.exec(text.trim());
    const address = match ? parseIpv4(match[1] as string) : undefined;
    const port = match ? Number(match[2]) : 0;
    if (!address || port < 1 || port > 65535) return undefined;
    return { address: [address[0], address[1], address[2], address[3]], port };
}

/** A list of plugin names, as Pumpkin reports them. */
export function pluginNames(options: { description: string; default: string[] }): Field<string[]> {
    return field<string[]>({
        type: 'string[]',
        description: options.description,
        default: options.default,
        expected: 'a list of plugin names like ["BedrockAddonManager"]',
        example: options.default,
        parse: (raw) =>
            Array.isArray(raw) && raw.every((name) => typeof name === 'string' && name.length > 0)
                ? { ok: true, value: raw }
                : { ok: false },
        format: (names) => `[${names.map(tomlString).join(', ')}]`,
    }) as Field<string[]>;
}
