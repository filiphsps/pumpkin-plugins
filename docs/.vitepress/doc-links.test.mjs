import assert from 'node:assert/strict';
import { it } from 'node:test';
import config from './config.mts';

function transformLinks(relativePath, hrefs) {
    const rules = [];
    const markdown = {
        core: {
            ruler: {
                push(_name, rule) {
                    rules.push(rule);
                },
            },
        },
    };
    const links = hrefs.map((href) => ({
        type: 'link_open',
        href,
        attrGet(name) {
            return name === 'href' ? this.href : null;
        },
        attrSet(name, value) {
            if (name === 'href') this.href = value;
        },
    }));
    const state = { env: { relativePath }, tokens: [{ children: links }] };

    config.markdown.config(markdown);
    for (const rule of rules) rule(state);

    return links.map(({ href }) => href);
}

it('rewrites repository guide links to site routes and preserves other links', () => {
    assert.deepEqual(
        transformLinks('tools/static-hermes-runtime/docs/wasi.md', [
            '../../../docs/building.md',
            '../../../docs/creating-a-plugin.md#files-and-network-access',
            '../README.md',
            'https://example.com/guide',
        ]),
        [
            '/guides/building',
            '/guides/creating-a-plugin#files-and-network-access',
            '../README.md',
            'https://example.com/guide',
        ],
    );
});
