// Run with the pinned release-please runtime supplied by pnpm dlx. --dry-run makes no GitHub writes.

import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { bundledChangesPlugin, workspacePackages } from './release-commits.mjs';

const args = process.argv.slice(2);
if (
    args.some(
        (arg) =>
            arg.startsWith('--') &&
            arg !== '--dry-run' &&
            arg !== '--pull-requests-only' &&
            !/^--component=.+$/.test(arg)
    )
) {
    throw new Error('Supported options: --dry-run, --pull-requests-only, --component=<name>');
}
const cliPath = args.find((arg) => !arg.startsWith('--'));
if (!cliPath) throw new Error('Pass the release-please executable path from pnpm dlx');
const requireRuntime = createRequire(resolve(cliPath));
const { GitHub, Manifest, VERSION } = requireRuntime('release-please');
if (VERSION !== '17.11.2') throw new Error(`Expected release-please 17.11.2, received ${VERSION}`);
const [owner, repo] = (process.env.GITHUB_REPOSITORY ?? '').split('/');
if (!owner || !repo || !process.env.RELEASE_PLEASE_TOKEN)
    throw new Error('GITHUB_REPOSITORY and RELEASE_PLEASE_TOKEN are required');
const github = await GitHub.create({ owner, repo, token: process.env.RELEASE_PLEASE_TOKEN });
const branch = github.repository.defaultBranch;
const packages = workspacePackages(resolve(import.meta.dirname, '..'));
if (
    args.some((arg) => arg.startsWith('--component=')) &&
    !args.includes('--dry-run') &&
    !args.includes('--pull-requests-only')
) {
    throw new Error('--component requires --dry-run or --pull-requests-only');
}
const load = () => Manifest.fromManifest(github, branch, 'release-please-config.json', '.release-please-manifest.json');
const outputs = { paths_released: '[]', prs: '[]' };

if (!args.includes('--dry-run') && !args.includes('--pull-requests-only')) {
    const manifest = await load();
    const releases = (await manifest.createReleases()).filter(Boolean);
    outputs.paths_released = JSON.stringify(releases.map((release) => release.path));
    for (const release of releases) {
        outputs[`${release.path}--release_created`] = true;
        for (const [name, value] of Object.entries(release)) {
            const key = { tagName: 'tag_name', uploadUrl: 'upload_url', notes: 'body', url: 'html_url' }[name] ?? name;
            outputs[`${release.path}--${key}`] = value;
        }
    }
}
const manifest = await load();
manifest.plugins.push(
    bundledChangesPlugin(github, branch, packages, manifest.releasedVersions, manifest.commitSearchDepth)
);
const component = args.find((arg) => arg.startsWith('--component='))?.slice('--component='.length);
if (component) {
    manifest.plugins.push({
        preconfigure: async (strategies) => strategies,
        processCommits: (commits) => commits,
        run: async (candidates) => candidates.filter((candidate) => candidate.config.component === component)
    });
}
if (args.includes('--dry-run')) {
    const candidates = await manifest.buildPullRequests();
    console.log(
        JSON.stringify(
            candidates.map((pr) => ({
                title: pr.title.toString(),
                body: pr.body.toString(),
                branch: pr.headRefName.toString()
            })),
            null,
            4
        )
    );
} else {
    outputs.prs = JSON.stringify((await manifest.createPullRequests()).filter(Boolean));
    if (process.env.GITHUB_OUTPUT) {
        for (const [name, value] of Object.entries(outputs)) {
            const marker = `release_${randomUUID()}`;
            appendFileSync(
                process.env.GITHUB_OUTPUT,
                `${name}<<${marker}\n${typeof value === 'string' ? value : JSON.stringify(value)}\n${marker}\n`
            );
        }
    }
    console.log(`Prepared ${JSON.parse(outputs.prs).length} release PR(s)`);
}
