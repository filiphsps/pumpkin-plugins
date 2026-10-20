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
    table,
} from '@pumpkin-plugins/config';
import { PLUGIN_NAME } from '../name.ts';
import { httpBaseUrl, httpUrl, ipv4Address, relativeFolder } from './fields.ts';

/** Name of the config file in the plugin's data folder. */
export const CONFIG_FILE = 'config.toml';

/** Header note of the config file. */
export const CONFIG_RENDER_OPTIONS: RenderOptions = {
    note: `${MANAGED_NOTE} Changes apply after \`/baddon reload\` or a server restart.`,
};

/** Every setting of the plugin. The default file, the validation and the README table all come from this. */
export const configSchema = defineConfig(PLUGIN_NAME, {
    web: section({
        description: 'The web server that serves the packs to Bedrock clients.',
        fields: {
            enabled: bool({
                description:
                    'Serve the packs over HTTP. Turn this off if the packs are hosted elsewhere and every pack has a download_url override.',
                default: true,
            }),
            bind: ipv4Address({ description: 'IPv4 address to listen on.', default: '0.0.0.0' }),
            port: int({ description: 'Port to listen on.', default: 8123, min: 1, max: 65535 }),
            public_url: httpBaseUrl({
                description:
                    'Base URL Bedrock clients should use to download packs, without a trailing slash, query or fragment; for example "https://packs.example.com". The plugin serves plain HTTP. Put a reverse proxy in front of it for HTTPS. When empty, the plugin uses the public address reported by UPnPumpkin if forwarding succeeds, or a loopback URL on the configured port otherwise. A loopback URL works only for players on the server machine.',
                default: '',
                allowEmpty: true,
            }),
            port_forwarding: bool({
                description:
                    'Set to true to have UPnPumpkin open `port` on your router (UPnP or NAT-PMP) and use the public address it returns. It only applies when `public_url` is empty and `bind` is "0.0.0.0". No port is opened when this machine already has a public address or UPnPumpkin is not installed. Off by default because it changes your router.',
                default: false,
            }),
        },
    }),
    packs: section({
        description: 'Where the packs are and how they are listed.',
        fields: {
            directory: relativeFolder({
                description: "Folder inside this plugin's data folder that is scanned for .mcpack and .mcaddon files.",
                default: 'packs',
            }),
            force: bool({
                description:
                    'Require players to accept the packs before they can join. `/baddon export` writes it as `resource_pack.bedrock.force`.',
                default: false,
            }),
        },
    }),
    overrides: table({
        description:
            'Per-pack overrides, keyed by file name. For packs extracted from a `.mcaddon`, use the name shown by `/baddon list`. All settings are optional. Packs are ordered by `order` (lowest first, default 0), then by file name. Except for `enabled`, they only reach players through the block `/baddon export` prints.',
        entryName: 'file',
        exampleKey: 'My Pack.mcpack',
        fields: {
            enabled: bool({ description: 'Set to false to leave the pack out entirely.', example: false }),
            order: int({
                description: 'Position in the pack list and in the exported block, lowest first.',
                example: 10,
            }),
            download_url: httpUrl({
                description: 'Download the pack from this URL instead of the built-in web server, for example a CDN.',
                example: 'https://cdn.example.com/my-pack.mcpack',
            }),
            addon_pack: bool({
                description: 'Mark the pack as an add-on pack. Normally derived from the manifest.',
                example: true,
            }),
            has_scripts: bool({
                description: 'Mark the pack as containing scripts. Normally derived from the manifest.',
                example: false,
            }),
            rtx_enabled: bool({
                description: 'Enable ray tracing for the pack. Normally derived from the manifest.',
                example: false,
            }),
            sub_pack_name: str({ description: 'Name of the sub-pack to activate.', example: 'high_res' }),
            content_key: str({ description: 'Decryption key for an encrypted pack.', example: '...' }),
            content_id: str({ description: 'Content identifier of the pack.', example: '...' }),
        },
    }),
});

/** The plugin's settings, typed from the schema. */
export type Config = ConfigValues<typeof configSchema>;

/** The `config` section of the plugin's `info`, for the generated README. */
export const configInfo = describeConfig(configSchema, CONFIG_FILE, CONFIG_RENDER_OPTIONS);
