import { describe, expect, it } from 'vitest';
import { componentApiRoute, githubPagesUrl, githubRepositoryUrl } from './site.ts';

describe('githubPagesUrl', () => {
    it('derives a project Pages URL from a repository object', () => {
        expect(githubPagesUrl({ url: 'git+https://github.com/FilipHsPs/pumpkin-plugins.git' })?.href).toBe(
            'https://filiphsps.github.io/pumpkin-plugins/'
        );
    });

    it('supports a repository string and user Pages sites', () => {
        expect(githubPagesUrl('https://github.com/example/example.github.io')?.href).toBe('https://example.github.io/');
    });

    it('returns no URL for unsupported repository metadata', () => {
        expect(githubPagesUrl({ url: 'https://example.com/repo' })).toBeUndefined();
    });
});

it('normalizes source repository URLs and derives shared API routes', () => {
    expect(githubRepositoryUrl({ url: 'git+https://github.com/example/repo.git' })?.href).toBe(
        'https://github.com/example/repo'
    );
    expect(githubRepositoryUrl('https://example.com/repo')).toBeUndefined();
    expect(componentApiRoute('packages', 'plugin')).toBe('api/plugins/plugin/');
    expect(componentApiRoute('tools', 'tool', '@scope/tool')).toBe('api/tools/@scope/tool/');
    expect(componentApiRoute('actions', 'action')).toBe('api/actions/action/');
});
