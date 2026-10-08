import { commandInfos } from '@pumpkin-plugins/docs';
import { describe, expect, it } from 'vitest';
import { ADMIN_PERMISSION, COMMAND_PERMISSION, commands } from './spec.ts';

describe('waypoint commands', () => {
    it('documents the supported vanilla command paths from the command declaration', () => {
        expect(commandInfos(commands).map(({ usage }) => usage)).toEqual([
            '/wp mark <name>',
            '/wp add <name> <x> <y> <z>',
            '/wp list',
            '/wp list <scope>',
            '/wp show <id>',
            '/wp access public <id>',
            '/wp access private <id>',
            '/wp access allowlist <id>',
            '/wp access invite <id> <player>',
            '/wp access revoke <id> <player>',
            '/wp locator on <id>',
            '/wp locator off <id>',
            '/wp locator color <id> <hex>',
            '/wp locator java-style <id> <style>',
            '/wp remove <id>',
            '/wp send <id> <adapter>',
            '/wp send-to <id> <player> <adapter>',
            '/wp admin list',
            '/wp admin remove <id>'
        ]);
    });

    it('keeps public commands open and applies the operator default only to admin commands', () => {
        const infos = commandInfos(commands);
        expect(infos.find(({ usage }) => usage === '/wp mark <name>')).toMatchObject({
            permission: COMMAND_PERMISSION,
            defaultPermission: { tag: 'allow' }
        });
        expect(infos.filter(({ usage }) => usage.startsWith('/wp admin '))).toHaveLength(2);
        expect(
            infos
                .filter(({ usage }) => usage.startsWith('/wp admin '))
                .every(
                    ({ permission, defaultPermission }) =>
                        permission === ADMIN_PERMISSION && defaultPermission?.tag === 'op'
                )
        ).toBe(true);
    });
});
