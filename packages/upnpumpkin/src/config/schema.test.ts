import { defaultValues } from '@pumpkin-plugins/config';
import { describe, expect, it } from 'vitest';
import { parseEndpoint } from './fields.ts';
import { configSchema } from './schema.ts';

describe('configSchema', () => {
    it('has the defaults the documentation promises', () => {
        expect(defaultValues(configSchema)).toEqual({
            router: {
                upnp: true,
                nat_pmp: true,
                lease_seconds: 3600,
                upnp_search: '239.255.255.250:1900',
                nat_pmp_gateway: ''
            },
            java: { enabled: true, port: 25565 },
            bedrock: { enabled: true, port: 19132 },
            plugins: { allow_requests: true }
        });
    });
});

describe('parseEndpoint', () => {
    it('reads address:port and rejects the rest', () => {
        expect(parseEndpoint('192.168.1.1:5351')).toEqual({ address: [192, 168, 1, 1], port: 5351 });
        for (const bad of ['', '192.168.1.1', 'router:5351', '1.2.3.4:0', '1.2.3.4:70000', '1.2.3.4:x', '::1:80'])
            expect(parseEndpoint(bad)).toBeUndefined();
    });
});
