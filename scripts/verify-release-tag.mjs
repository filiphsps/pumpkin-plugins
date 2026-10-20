// Checks that a release tag on GitHub points at the commit a release job is about to publish.
// Release workflows run it before they upload or publish anything. It reads the repository from
// GH_REPO, like the gh CLI.
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { Command } from 'commander';

/** Annotated tags can point at other tags; stop following them after this many. */
const MAX_TAG_DEPTH = 5;

/** Reads the type and SHA of the object a GitHub git ref or tag object points at. */
function readObject(endpoint) {
    const output = execFileSync(
        'gh',
        ['api', `repos/{owner}/{repo}/${endpoint}`, '--jq', '.object.type + " " + .object.sha'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
    );
    const [type, sha] = output.trim().split(' ');
    return { type, sha };
}

/** Follows a tag through annotated tag objects and returns the object it finally names. */
function resolveTag(tag) {
    let object = readObject(`git/ref/tags/${tag}`);
    for (let depth = 0; object.type === 'tag' && depth < MAX_TAG_DEPTH; depth += 1) {
        object = readObject(`git/tags/${object.sha}`);
    }
    return object;
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
    const program = new Command()
        .name('verify-release-tag')
        .description('Check that a GitHub release tag points at the expected commit.')
        .argument('<tag>', 'Release tag')
        .argument('<expected-sha>', 'Commit the tag must point at')
        .parse(process.argv);
    const [tag, expected] = program.processedArgs;
    let object;
    try {
        object = resolveTag(tag);
    } catch {
        console.error(`Could not read tag ${tag} from GitHub.`);
        process.exit(1);
    }
    if (object.type !== 'commit' || object.sha !== expected) {
        console.log(`::error::${tag} resolves to ${object.type} ${object.sha}, but the release commit is ${expected}.`);
        process.exit(1);
    }
    console.log(`Verified ${tag} at ${expected}.`);
}
