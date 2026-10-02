import { bool, defineConfig, int, section, str, table } from '../src/index.ts';

/** A small schema with every kind of node and field, shared by the tests. */
export const demo = defineConfig('Demo', {
    web: section({
        description: 'The web server.',
        fields: {
            enabled: bool({ description: 'Serve over HTTP.', default: true }),
            port: int({ description: 'Port to listen on.', default: 8123, min: 1, max: 65535 }),
            base_url: str({
                description: 'Base URL, without a trailing slash.',
                default: '',
                check: {
                    expected: 'an http:// or https:// URL',
                    test: (v) => v === '' || /^https?:\/\//.test(v),
                    normalize: (v) => v.replace(/\/+$/, '')
                }
            }),
            token: str({ description: 'Optional access token.', example: 'secret' })
        }
    }),
    overrides: table({
        description: 'Per-file settings.',
        entryName: 'file',
        exampleKey: 'a.txt',
        fields: {
            order: int({ description: 'Sort order.', example: 10 }),
            enabled: bool({ description: 'Include the file.', example: true })
        }
    })
});

/** An in-memory config file that records writes. */
export class MemoryStore {
    writes = 0;
    constructor(public text?: string) {}

    read(): string | undefined {
        return this.text;
    }

    write(text: string): void {
        this.text = text;
        this.writes++;
    }
}
