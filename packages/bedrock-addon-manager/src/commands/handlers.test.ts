import { buildCommands } from '@pumpkin-plugins/plugin-kit/commands';
import { FakeCommandHost, type FakeNode, MemoryFiles, MemoryLogger } from '@pumpkin-plugins/plugin-kit/testing';
import { parse } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import { FakeServer } from '../../test/fake-server.ts';
import { FakeUpnpumpkin } from '../../test/fake-upnpumpkin.ts';
import { makeMcpack, manifestJson } from '../../test/fixtures.ts';
import { CONFIG_FILE } from '../config/schema.ts';
import { info } from '../info.ts';
import { PackManager } from '../manager.ts';
import { commandHandlers } from './handlers.ts';
import { COMMAND_PERMISSION, commands } from './spec.ts';

const PACK = makeMcpack(manifestJson());

function setup(config?: string) {
    const files = new MemoryFiles();
    files.put('packs/a.mcpack', PACK);
    if (config) files.put(CONFIG_FILE, config);
    const manager = new PackManager(files, new MemoryLogger(), () => new FakeServer(), new FakeUpnpumpkin().send);
    manager.start();
    const host = new FakeCommandHost();
    const built = buildCommands(host, commands, commandHandlers(manager));
    return { files, manager, host, root: built[0]?.node as FakeNode };
}

describe('the /baddon commands', () => {
    it('are registered exactly as the README lists them', () => {
        const { host, root } = setup();
        expect(host.usages(root).sort()).toEqual((info.commands ?? []).map((c) => c.usage).sort());
        expect(new Set(info.commands.map((c) => c.permission))).toEqual(
            new Set([`${COMMAND_PERMISSION}.list`, `${COMMAND_PERMISSION}.reload`, `${COMMAND_PERMISSION}.export`]),
        );
    });

    it('are for operators only, because the listing shows file names, UUIDs and download URLs', () => {
        for (const command of info.commands) {
            expect(command.defaultPermission, command.usage).toEqual({ tag: 'op', val: 'three' });
        }
    });

    it('export the listed packs as a pumpkin.toml block with packs.force and exact sizes', () => {
        const { host, root } = setup('[packs]\nforce = true\n');
        const toml = parse(host.run(root, ['baddon', 'export']).join('\n'));
        expect(toml).toMatchObject({
            resource_pack: { bedrock: { enabled: true, force: true, packs: [{ size: PACK.length }] } },
        });
    });
});
