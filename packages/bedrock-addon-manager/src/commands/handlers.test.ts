import { commandInfos } from '@pumpkin-plugins/docs';
import { buildCommands } from '@pumpkin-plugins/plugin-kit/commands';
import { FakeCommandHost, type FakeNode } from '@pumpkin-plugins/plugin-kit/testing';
import { describe, expect, it } from 'vitest';
import { FakeServer } from '../../test/fake-server.ts';
import { FakeUpnpumpkin } from '../../test/fake-upnpumpkin.ts';
import { makeMcpack, manifestJson } from '../../test/fixtures.ts';
import { MemoryLogger } from '../../test/logger.ts';
import { MemoryFiles } from '../../test/memory-files.ts';
import { info } from '../info.ts';
import { PackManager } from '../manager.ts';
import { commandHandlers } from './handlers.ts';
import { COMMAND_PERMISSION, commands } from './spec.ts';

function setup() {
    const files = new MemoryFiles();
    files.put('packs/a.mcpack', makeMcpack(manifestJson()));
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
        expect(info.commands).toEqual(commandInfos(commands));
        expect(new Set(info.commands.map((c) => c.permission))).toEqual(new Set([COMMAND_PERMISSION]));
    });

    it('list prints the packs found', () => {
        const { host, root } = setup();
        const lines = host.run(root, ['baddon', 'list']);
        expect(lines[0]).toBe('Bedrock packs (1), in the order they are listed:');
        expect(lines[1]).toContain('a.mcpack');
    });

    it('reload rescans the packs folder and says how many are listed', () => {
        const { files, manager, host, root } = setup();
        files.put('packs/b.mcpack', makeMcpack(manifestJson({ uuid: '33333333-3333-4333-8333-333333333333' })));
        expect(host.run(root, ['baddon', 'reload'])[0]).toContain('2 packs listed');
        expect(manager.entries).toHaveLength(2);
    });
});
