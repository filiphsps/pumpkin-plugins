import { describe, expect, it } from 'vitest';
import { run } from './cli.ts';
import { BuildError } from './errors.ts';

describe('run arguments', () => {
    it('rejects unsupported arguments before reading package configuration', async () => {
        await expect(run(['--types-onyl'], '/not-a-package')).rejects.toThrow(BuildError);
        await expect(run(['--types-onyl'], '/not-a-package')).rejects.toThrow(
            'unknown argument "--types-onyl" (supported: --types-only)'
        );
    });
});
