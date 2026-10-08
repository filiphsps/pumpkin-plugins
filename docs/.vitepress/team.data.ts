import type { DefaultTheme, LoaderModule } from 'vitepress';
import { loadTeamMembers } from './team-data.mjs';

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
    load: loadTeamMembers
} satisfies LoaderModule;
