import assert from 'node:assert/strict';
import { it } from 'node:test';
import { enableLegacyReleaseTitleParsing } from './release-title-compat.mjs';

// biome-ignore lint/suspicious/noTemplateCurlyInString: Release Please requires literal placeholders in these patterns.
const currentTitlePattern = 'chore${scope}: release @pumpkin-plugins/${component} ${version}';
// biome-ignore lint/suspicious/noTemplateCurlyInString: Release Please requires literal placeholders in these patterns.
const legacyTitlePattern = 'chore${scope}: release${component} ${version}';

it('enables legacy title parsing without changing release title patterns', () => {
    const manifest = {
        groupPullRequestTitlePattern: undefined,
        repositoryConfig: {
            'tools/cspell-dict-minecraft': {
                component: 'cspell-dict-minecraft',
                componentNoSpace: true,
                pullRequestTitlePattern: currentTitlePattern,
            },
            'tools/create-pumpkin-plugin': {
                component: 'create-pumpkin-plugin',
            },
        },
    };

    enableLegacyReleaseTitleParsing(manifest);

    assert.equal(manifest.groupPullRequestTitlePattern, legacyTitlePattern);
    assert.deepEqual(manifest.repositoryConfig, {
        'tools/cspell-dict-minecraft': {
            component: 'cspell-dict-minecraft',
            componentNoSpace: false,
            pullRequestTitlePattern: currentTitlePattern,
        },
        'tools/create-pumpkin-plugin': {
            component: 'create-pumpkin-plugin',
            componentNoSpace: false,
        },
    });
});

it('preserves an explicitly configured fallback title pattern', () => {
    const configuredFallbackPattern = 'custom fallback';
    const manifest = {
        groupPullRequestTitlePattern: configuredFallbackPattern,
        repositoryConfig: { 'tools/cspell-dict-minecraft': { componentNoSpace: true } },
    };

    enableLegacyReleaseTitleParsing(manifest);

    assert.equal(manifest.groupPullRequestTitlePattern, configuredFallbackPattern);
    assert.equal(manifest.repositoryConfig['tools/cspell-dict-minecraft'].componentNoSpace, false);
});
