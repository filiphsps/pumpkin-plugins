import { describe, expect, it } from 'vitest';
import { demo } from '../test/schema.ts';
import { describeConfig } from './describe.ts';
import { renderConfig } from './render.ts';
import { defaultValues } from './schema.ts';

describe('describeConfig', () => {
    const info = describeConfig(demo, 'config.toml');

    it('shows exactly the file a fresh install gets', () => {
        expect(info.file).toBe('config.toml');
        expect(info.defaultContents).toBe(renderConfig(demo, defaultValues(demo)));
    });

    it('lists every setting with its type and default', () => {
        expect(info.options).toEqual([
            { key: 'web.enabled', type: 'boolean', default: 'true', description: 'Serve over HTTP.' },
            { key: 'web.port', type: 'integer', default: '8123', description: 'Port to listen on.' },
            { key: 'web.base_url', type: 'string', default: '""', description: 'Base URL, without a trailing slash.' },
            { key: 'web.token', type: 'string', description: 'Optional access token.' },
            { key: 'overrides."<file>".order', type: 'integer', description: 'Sort order.' },
            { key: 'overrides."<file>".enabled', type: 'boolean', description: 'Include the file.' }
        ]);
    });
});
