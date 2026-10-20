import type { WorkloadScenario } from '../benchmark-workloads.ts';
import { PERMISSION_WORLDS } from './shared.ts';

const PERMISSION_CHECK_COUNT = 12_000;

/** Permission inheritance and context lookup workload. */
export const PERMISSION_WORKLOADS: readonly WorkloadScenario[] = [
    {
        name: 'permission-resolution',
        area: 'Permission inheritance and context lookup',
        operationsPerSample: PERMISSION_CHECK_COUNT,
        run: runPermissionResolution,
    },
];

interface PermissionGroup {
    contexts: ReadonlyMap<string, boolean>;
    parent?: string;
    permissions: ReadonlyMap<string, boolean>;
}

const PERMISSION_GROUPS = new Map<string, PermissionGroup>([
    [
        'default',
        {
            permissions: new Map([
                ['essentials.home', true],
                ['essentials.balance', true],
                ['worldguard.build', false],
            ]),
            contexts: new Map(),
        },
    ],
    [
        'member',
        {
            parent: 'default',
            permissions: new Map([
                ['essentials.warp', true],
                ['economy.pay', true],
            ]),
            contexts: new Map([['spawn:worldguard.build', true]]),
        },
    ],
    [
        'moderator',
        {
            parent: 'member',
            permissions: new Map([
                ['essentials.teleport', true],
                ['coreprotect.*', true],
            ]),
            contexts: new Map(),
        },
    ],
    [
        'admin',
        {
            parent: 'moderator',
            permissions: new Map([['*', true]]),
            contexts: new Map(),
        },
    ],
]);

const PERMISSION_NODES = [
    'essentials.home',
    'essentials.warp',
    'essentials.teleport',
    'essentials.balance',
    'essentials.message',
    'economy.pay',
    'worldguard.build',
    'worldguard.interact',
    'coreprotect.inspect',
    'minecraft.command.gamemode',
];

const PERMISSION_GROUP_NAMES = ['default', 'member', 'moderator', 'admin'];

function runPermissionResolution(): number {
    let checksum = 0;
    for (let index = 0; index < PERMISSION_CHECK_COUNT; index++) {
        const group = PERMISSION_GROUP_NAMES[index % PERMISSION_GROUP_NAMES.length];
        const permission = PERMISSION_NODES[index % PERMISSION_NODES.length];
        const world = PERMISSION_WORLDS[index % PERMISSION_WORLDS.length];
        if (hasPermission(group, permission, world)) checksum += permission.length + (index % 17);
    }
    return checksum;
}

function hasPermission(groupName: string, permission: string, world: string): boolean {
    let group = PERMISSION_GROUPS.get(groupName);
    while (group !== undefined) {
        const contextualPermission = group.contexts.get(`${world}:${permission}`);
        if (contextualPermission !== undefined) return contextualPermission;

        const exactPermission = group.permissions.get(permission);
        if (exactPermission !== undefined) return exactPermission;

        for (
            let separator = permission.lastIndexOf('.');
            separator >= 0;
            separator = permission.lastIndexOf('.', separator - 1)
        ) {
            const wildcardPermission = group.permissions.get(`${permission.slice(0, separator)}.*`);
            if (wildcardPermission !== undefined) return wildcardPermission;
        }

        const globalPermission = group.permissions.get('*');
        if (globalPermission !== undefined) return globalPermission;
        group = group.parent === undefined ? undefined : PERMISSION_GROUPS.get(group.parent);
    }
    return false;
}
