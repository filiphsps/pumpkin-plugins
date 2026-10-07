import {
    bool,
    type ConfigValues,
    defineConfig,
    describeConfig,
    int,
    MANAGED_NOTE,
    type RenderOptions,
    section,
    str,
    table
} from '@pumpkin-plugins/config';
import { httpUrl, ipv4Address, relativeFolder } from './fields.ts';

/** Name of the config file in the plugin's data folder. */
export const CONFIG_FILE = 'config.toml';

/** Header note of the config file. */
export const CONFIG_RENDER_OPTIONS: RenderOptions = {
    note: `${MANAGED_NOTE} Changes apply after \`/baddon reload\` or a server restart.`
};

/** Every setting of the plugin. The default file, the validation and the README table all come from this. */
export const configSchema = defineConfig('BedrockAddonManager', {
    web: section({
        description: 'The web server that serves the packs to Bedrock clients.',
        fields: {
            enabled: bool({
                description:
                    'Serve the packs over HTTP. Turn this off if the packs are hosted elsewhere and every pack has a download_url override.',
                default: true
            }),
            bind: ipv4Address({ description: 'IPv4 address to listen on.', default: '0.0.0.0' }),
            port: int({ description: 'Port to listen on.', default: 8123, min: 1, max: 65535 }),
            public_url: httpUrl({
                description:
                    'Base URL Bedrock clients download packs from, without a trailing slash, for example "https://packs.example.com". The plugin only speaks plain HTTP: put a reverse proxy in front of it for HTTPS. Left empty, the address that `port_forwarding` makes reachable is used, else a loopback URL using the configured port, which only works for players on the server machine.',
                default: '',
                allowEmpty: true
            }),
            port_forwarding: bool({
                description:
                    'When `public_url` is empty and `bind` is "0.0.0.0", ask the UPnPumpkin plugin to open `port` on your router (UPnP or NAT-PMP) and use the public address it gets. Nothing is opened when this machine already has a public address, or when UPnPumpkin is not installed. Set to false to turn this off.',
                default: true
            })
        }
    }),
    packs: section({
        description: 'Where the packs are and how they are listed.',
        fields: {
            directory: relativeFolder({
                description: "Folder inside this plugin's data folder that is scanned for .mcpack and .mcaddon files.",
                default: 'packs'
            }),
            force: bool({
                description: 'Make Bedrock clients download the packs before they can join.',
                default: false
            })
        }
    }),
    overrides: table({
        description:
            'Per-pack overrides, keyed by file name (for a pack from a .mcaddon, the name /baddon list shows). Every setting is optional. Packs are listed by order (lowest first, default 0), then by file name.',
        entryName: 'file',
        exampleKey: 'My Pack.mcpack',
        fields: {
            enabled: bool({ description: 'Set to false to leave the pack out entirely.', example: false }),
            order: int({ description: 'Position in the pack list, lowest first.', example: 10 }),
            download_url: httpUrl({
                description: 'Download the pack from this URL instead of the built-in web server, for example a CDN.',
                example: 'https://cdn.example.com/my-pack.mcpack'
            }),
            addon_pack: bool({
                description: 'Mark the pack as an add-on pack. Normally derived from the manifest.',
                example: true
            }),
            has_scripts: bool({
                description: 'Mark the pack as containing scripts. Normally derived from the manifest.',
                example: false
            }),
            rtx_enabled: bool({
                description: 'Enable ray tracing for the pack. Normally derived from the manifest.',
                example: false
            }),
            sub_pack_name: str({ description: 'Name of the sub-pack to activate.', example: 'high_res' }),
            content_key: str({ description: 'Decryption key for an encrypted pack.', example: '...' }),
            content_id: str({ description: 'Content identifier of the pack.', example: '...' })
        }
    })
});

/** The plugin's settings, typed from the schema. */
export type Config = ConfigValues<typeof configSchema>;

/** The `config` section of the plugin's `info`, for the generated README. */
export const configInfo = describeConfig(configSchema, CONFIG_FILE, CONFIG_RENDER_OPTIONS);
