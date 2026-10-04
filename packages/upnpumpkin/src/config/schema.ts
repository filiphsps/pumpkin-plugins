import {
    bool,
    type ConfigValues,
    defineConfig,
    describeConfig,
    int,
    MANAGED_NOTE,
    type RenderOptions,
    section
} from '@pumpkin-plugins/config';
import { ipv4Endpoint } from './fields.ts';

/** Name of the config file in the plugin's data folder. */
export const CONFIG_FILE = 'config.toml';

/** Header note of the config file. */
export const CONFIG_RENDER_OPTIONS: RenderOptions = {
    note: `${MANAGED_NOTE} Changes apply after \`/upnp reload\` or a server restart.`
};

/** Every setting of the plugin. The default file, the validation and the README table all come from this. */
export const configSchema = defineConfig('UPnPumpkin', {
    router: section({
        description: 'How the router is found and how long it keeps the ports open.',
        fields: {
            upnp: bool({ description: 'Look for routers that speak UPnP.', default: true }),
            nat_pmp: bool({ description: 'Look for routers that speak NAT-PMP.', default: true }),
            lease_seconds: int({
                description:
                    'How long the router keeps a port open without hearing from the plugin. It is renewed at half this time and closed again when the server stops.',
                default: 3600,
                min: 120,
                max: 86400
            }),
            upnp_search: ipv4Endpoint({
                description:
                    'Where UPnP searches are sent. The default is the multicast address every router listens on. Set the router\'s own address (for example "192.168.1.1:1900") when multicast is blocked on your network.',
                default: '239.255.255.250:1900'
            }),
            nat_pmp_gateway: ipv4Endpoint({
                description:
                    'The router to use for NAT-PMP, as "address:5351". Empty means the first and last address of the local network are tried.',
                default: '',
                example: '192.168.1.1:5351'
            })
        }
    }),
    java: section({
        description: 'The Java Edition port (TCP).',
        fields: {
            enabled: bool({ description: 'Open the Java Edition port.', default: true }),
            port: int({ description: 'Port of the Java Edition listener.', default: 25565, min: 1, max: 65535 })
        }
    }),
    bedrock: section({
        description: 'The Bedrock Edition port (UDP).',
        fields: {
            enabled: bool({ description: 'Open the Bedrock Edition port.', default: true }),
            port: int({ description: 'Port of the Bedrock Edition listener.', default: 19132, min: 1, max: 65535 })
        }
    }),
    plugins: section({
        description: 'Requests from other plugins.',
        fields: {
            allow_requests: bool({
                description:
                    'Let other plugins ask for ports to be opened, for example BedrockAddonManager for its pack downloads. They are closed again when the plugin stops asking.',
                default: true
            }),
            max_requests_per_plugin: int({
                description: 'How many ports each plugin may keep open at once. Every plugin has its own limit.',
                default: 16,
                min: 1,
                max: 256
            })
        }
    })
});

/** The plugin's settings, typed from the schema. */
export type Config = ConfigValues<typeof configSchema>;

/** The `config` section of the plugin's `info`, for the generated README. */
export const configInfo = describeConfig(configSchema, CONFIG_FILE, CONFIG_RENDER_OPTIONS);
