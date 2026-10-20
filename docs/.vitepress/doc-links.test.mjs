import assert from 'node:assert/strict';
import fs from 'node:fs';
import { it } from 'node:test';
import { githubRepositoryUrl } from '@pumpkin-plugins/docs/node';
import config from './config.mts';

const { repository } = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const repoUrl = githubRepositoryUrl(repository)?.href;

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
            '/tools/static-hermes-runtime/README',
            'https://example.com/guide',
        ],
    );
});

it('rewrites links from guides to component READMEs', () => {
    assert.deepEqual(transformLinks('guides/building.md', ['../tools/static-hermes-runtime/README.md#hermes']), [
        '/tools/static-hermes-runtime/README#hermes',
    ]);
});

it('links repository files and folders without a site page to GitHub', () => {
    assert.deepEqual(
        transformLinks('tools/static-hermes-runtime/docs/maintaining-hermes.md', [
            '../hermes-patches',
            '../cmake/wasi-sdk-hermes-p2.cmake',
            '../package.json#L2',
            '../missing.cmake',
            '../../../README.md',
        ]),
        [
            `${repoUrl}/tree/master/tools/static-hermes-runtime/hermes-patches`,
            `${repoUrl}/blob/master/tools/static-hermes-runtime/cmake/wasi-sdk-hermes-p2.cmake`,
            `${repoUrl}/blob/master/tools/static-hermes-runtime/package.json#L2`,
            '../missing.cmake',
            '../../../README.md',
        ],
    );
    assert.deepEqual(transformLinks('guides/ci-and-releases.md', ['../.github/workflows/']), [
        `${repoUrl}/tree/master/.github/workflows`,
    ]);
    assert.deepEqual(transformLinks('tools/pumpkin-api/README.md', ['../../docs/plugin-api/']), [
        '../../docs/plugin-api/',
    ]);
});
