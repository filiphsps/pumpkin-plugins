import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { DefaultTheme, LoaderModule } from 'vitepress';

interface Contributor {
    login: string;
    type: string;
    avatar_url: string;
    html_url: string;
    contributions: number;
}

interface TeamMember extends DefaultTheme.TeamMember {
    login: string;
    contributions: number;
}

/** Contributor cards generated from the repository's GitHub contributor list. */
declare const data: TeamMember[];

/** Exposes the generated cards to the Team page through VitePress. */
export { data };

/** Loads human contributors at build time, keeping credentials out of the client bundle. */
export default {
    watch: ['../../package.json'],
    async load(): Promise<TeamMember[]> {
        const manifest = JSON.parse(
            fs.readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8')
        );
        const repository = typeof manifest.repository === 'string' ? manifest.repository : manifest.repository.url;
        const repo = new URL(repository.replace(/^git\+/, '')).pathname.replace(/^\//, '').replace(/\.git$/, '');
        const headers: Record<string, string> = {
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28'
        };
        // biome-ignore lint/suspicious/noUndeclaredEnvVars: VitePress runs directly through pnpm, outside Turborepo.
        const token = process.env.GITHUB_TOKEN;
        if (token) headers.Authorization = `Bearer ${token}`;
        const members = new Map<string, TeamMember>();
        for (let page = 1; ; page++) {
            const response = await fetch(
                `https://api.github.com/repos/${repo}/contributors?per_page=100&page=${page}`,
                {
                    headers,
                    signal: AbortSignal.timeout(30_000)
                }
            );
            if (response.status === 204) break;
            if (!response.ok)
                throw new Error(
                    `GitHub contributor lookup failed (${response.status}). Set GITHUB_TOKEN if rate limited.`
                );
            const contributors: Contributor[] = await response.json();
            if (!Array.isArray(contributors)) throw new Error('GitHub returned an invalid contributor list.');
            for (const contributor of contributors) {
                if (
                    contributor.type !== 'User' ||
                    /(?:\[bot\]$|[-_]bot$)|^(?:renovate|dependabot|github-actions|github-bot|web-flow)$/i.test(
                        contributor.login
                    )
                )
                    continue;
                const profileResponse = await fetch(
                    `https://api.github.com/users/${encodeURIComponent(contributor.login)}`,
                    {
                        headers,
                        signal: AbortSignal.timeout(30_000)
                    }
                );
                if (!profileResponse.ok)
                    throw new Error(
                        `GitHub profile lookup failed (${profileResponse.status}) for ${contributor.login}.`
                    );
                const profile: { name?: string | null } = await profileResponse.json();
                const name = profile.name?.trim() || contributor.login;
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
} satisfies LoaderModule;
