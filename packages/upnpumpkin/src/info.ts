import { commandInfos, type PluginInfo } from '@pumpkin-plugins/docs';
import { BLOCKED_ROUTERS, renderBlockedRouters } from './blocklist.ts';
import { commands } from './commands/spec.ts';
import { configInfo } from './config/schema.ts';
import { PLUGIN_NAME } from './name.ts';

/** What the plugin is, what it needs and what it offers. Feeds both its Pumpkin metadata and its README. */
export const info = {
    name: PLUGIN_NAME,
    description:
        'Opens ports on your router with UPnP and NAT-PMP so players can reach the server from the internet, and lets other plugins ask for the same.',
    permissions: [
        { name: 'fs.read.data', reason: 'Read the plugin config in its data folder.' },
        { name: 'fs.write.data', reason: 'Create and update the config.' },
        { name: 'network.udp.bind', reason: 'Receive the answers of routers to UPnP searches and NAT-PMP requests.' },
        {
            name: 'network.udp.outgoingdatagram',
            reason: 'Search for routers (UPnP) and talk to them (NAT-PMP).'
        },
        { name: 'network.tcp.connect', reason: "Send UPnP commands to the router's control URL." }
    ],
    commands: commandInfos(commands),
    config: configInfo,
    blocks: { routers: renderBlockedRouters(BLOCKED_ROUTERS) }
} satisfies PluginInfo<typeof PLUGIN_NAME>;
