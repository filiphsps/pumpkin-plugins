import type { Context } from 'pumpkin:plugin/context@0.1.0';
import { commandInfos } from '@pumpkin-plugins/docs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({ register: vi.fn() }));

vi.mock('@pumpkin-plugins/plugin-kit/register-commands', () => ({ registerCommands: calls.register }));

import { registerCommands } from './register.ts';
import { commands } from './spec.ts';

describe('registerCommands', () => {
    beforeEach(() => vi.resetAllMocks());

    it('registers the public command spec without a global permission override', () => {
        const ctx = {} as Context;

        registerCommands(ctx, { togglePlayerLights: () => true });

        expect(calls.register).toHaveBeenCalledOnce();
        expect(calls.register.mock.calls[0]).toHaveLength(3);
        expect(calls.register).toHaveBeenCalledWith(
            ctx,
            commands,
            expect.objectContaining({ dynamiclights: expect.any(Function) })
        );
        expect(commandInfos(commands)[0]?.defaultPermission).toEqual({ tag: 'allow' });
    });
});
