import { commandInfos } from '@pumpkin-plugins/docs';
import { describe, expect, it } from 'vitest';
import { ADMIN_PERMISSION, COMMAND_PERMISSION, commands } from './spec.ts';

describe('waypoint commands', () => {
    it('declares the redesigned public and operator command surface', () => {
        const usages = commandInfos(commands).map(({ usage }) => usage);
        expect(usages).toEqual([
            '/wp create',
            '/wp create <name>',
            '/wp create <name> <x> <y> <z>',
            '/wp delete <name>',
            '/wp rename <name> <newName>',
            '/wp relocate',
            '/wp relocate <name>',
            '/wp relocate <name> <x> <y> <z>',
            '/wp list',
            '/wp info <name>',
            '/wp teleport',
            '/wp teleport <name>',
            '/wp teleport <name> <targets>',
            '/wp tp',
            '/wp tp <name>',
            '/wp tp <name> <targets>',
            '/wp enable <name>',
            '/wp disable <name>',
            '/wp get <name>',
            '/wp access public <name>',
            '/wp access restricted <name>',
            '/wp access list <name>',
            '/wp access grant player <name> <player>',
            '/wp access grant permission <name> <permission>',
            '/wp access grant group <name> <group>',
            '/wp access revoke player <name> <player>',
            '/wp access revoke permission <name> <permission>',
            '/wp access revoke group <name> <group>',
            '/wp set color <name> <hex>',
            '/wp set icon <name> <item>',
            '/wp set label <name> <label>',
            '/wp set description <name> <description>',
            '/wp set visibility-range <name> <range>',
            '/wp reset <name> <property>'
        ]);
        expect(usages.some((usage) => /mark|locator|send|show|admin/.test(usage))).toBe(false);
    });

    it('separates player-readable commands from operator-guarded mutations', () => {
        const infos = commandInfos(commands);
        expect(infos.find(({ usage }) => usage === '/wp list')).toMatchObject({
            permission: COMMAND_PERMISSION,
            defaultPermission: { tag: 'allow' }
        });
        expect(infos.find(({ usage }) => usage === '/wp info <name>')).toMatchObject({
            permission: COMMAND_PERMISSION,
            defaultPermission: { tag: 'allow' }
        });
        expect(infos.find(({ usage }) => usage === '/wp create <name> <x> <y> <z>')).toMatchObject({
            permission: ADMIN_PERMISSION,
            defaultPermission: { tag: 'op' }
        });
        expect(infos.find(({ usage }) => usage === '/wp access grant permission <name> <permission>')).toMatchObject({
            permission: ADMIN_PERMISSION,
            defaultPermission: { tag: 'op' }
        });
    });
});
