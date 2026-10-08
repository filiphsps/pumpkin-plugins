import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const GITHUB_API = 'https://api.github.com';
const TEAM_NAME_QUERY = `query ContributorNames($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on User {
      login
      name
    }
  }
}`;

/** @typedef {{ login: string, node_id: string, type: string, avatar_url: string, html_url: string, contributions: number }} Contributor */

/** Loads human contributors at build time, keeping credentials out of the client bundle. */
export async function loadTeamMembers() {
    const manifest = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'));
    const repository = typeof manifest.repository === 'string' ? manifest.repository : manifest.repository.url;
    const repo = new URL(repository.replace(/^git\+/, '')).pathname.replace(/^\//, '').replace(/\.git$/, '');
    const headers = {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
    };
    // biome-ignore lint/suspicious/noUndeclaredEnvVars: VitePress runs directly through pnpm, outside Turborepo.
    const token = process.env.GITHUB_TOKEN;
    if (token) headers.Authorization = `Bearer ${token}`;
    const members = new Map();
    for (let page = 1; ; page++) {
        const response = await fetch(`${GITHUB_API}/repos/${repo}/contributors?per_page=100&page=${page}`, {
            headers,
            signal: AbortSignal.timeout(30_000)
        });
        if (response.status === 204) break;
        if (!response.ok)
            throw new Error(`GitHub contributor lookup failed (${response.status}). Set GITHUB_TOKEN if rate limited.`);
        /** @type {Contributor[]} */
        const contributors = await response.json();
        if (!Array.isArray(contributors)) throw new Error('GitHub returned an invalid contributor list.');

        const humans = contributors.filter(
            (contributor) =>
                contributor.type === 'User' &&
                !/(?:\[bot\]$|[-_]bot$)|^(?:renovate|dependabot|github-actions|github-bot|web-flow)$/i.test(
                    contributor.login
                )
        );
        const names = new Map(humans.map(({ login }) => [login, login]));
        if (
            token &&
            humans.length > 0 &&
            humans.every(({ node_id }) => typeof node_id === 'string' && node_id.length > 0)
        ) {
            try {
                const profileResponse = await fetch(`${GITHUB_API}/graphql`, {
                    method: 'POST',
                    headers: { ...headers, 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        query: TEAM_NAME_QUERY,
                        variables: { ids: humans.map(({ node_id }) => node_id) }
                    }),
                    signal: AbortSignal.timeout(30_000)
                });
                if (!profileResponse.ok) {
                    throw new Error(`GitHub contributor name lookup failed (HTTP ${profileResponse.status}).`);
                }
                const result = await profileResponse.json();
                if (result.errors?.length || !Array.isArray(result.data?.nodes)) {
                    throw new Error('GitHub returned an invalid contributor name response.');
                }
                for (const profile of result.data.nodes) {
                    const name = profile?.name?.trim();
                    if (profile?.login && name) names.set(profile.login, name);
                }
            } catch (error) {
                console.warn(`GitHub contributor name lookup failed; using usernames. ${error.message}`);
            }
        }

        for (const contributor of humans) {
            const name = names.get(contributor.login);
            const count = contributor.contributions;
            const owner = contributor.login.toLowerCase() === 'filiphsps';
            const contributionLabel = `${count.toLocaleString('en-US')} ${count === 1 ? 'contribution' : 'contributions'}`;
            members.set(contributor.login, {
                login: contributor.login,
                contributions: count,
                name,
                avatar: contributor.avatar_url,
                title: name === contributor.login ? 'Contributor' : `@${contributor.login}`,
                desc: `${owner ? '<span class="team-owner-label">Owner</span>' : ''}<span class="team-contribution-count">${contributionLabel}</span>`,
                links: [{ icon: 'github', link: contributor.html_url }]
            });
        }
        if (contributors.length < 100) break;
    }
    return [...members.values()].sort((left, right) => {
        const ownerOrder =
            Number(right.login.toLowerCase() === 'filiphsps') - Number(left.login.toLowerCase() === 'filiphsps');
        return ownerOrder || right.contributions - left.contributions || left.login.localeCompare(right.login);
    });
}
