import { commandInfos, type PluginInfo } from '@pumpkin-plugins/docs';
import { BLOCKED_ROUTERS, renderBlockedRouters } from './blocklist.ts';
import { commands } from './commands/spec.ts';
import { configInfo } from './config/schema.ts';
import { PLUGIN_NAME } from './name.ts';

/** Plugin metadata used by Pumpkin and the generated README. */
export const info = {
    name: PLUGIN_NAME,
    description:
        'Port forward ports on the router with UPnP or NAT-PMP so players can connect from the internet. Other plugins can request port mappings through UPnPumpkin.',
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
