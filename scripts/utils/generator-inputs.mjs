// Finds what the generator smoke test reads, so scripts/changed-areas.mjs selects it only for
// changes that can break the packages it generates.
import * as path from 'node:path';
import { dependencyClosure, localUses, workflowJob } from './workspace-discovery.mjs';

/**
 * Finds the generator smoke test's inputs: the generator configuration and its templates, the
 * workspace packages the templates and the root manifest depend on, root workspace configuration,
 * the workflow job with its local actions, and the root scripts that job runs.
 *
 * @throws When no workflow has a `generator` job or the repository has no generator configuration.
 */
export function generatorInputs(workspace) {
    const { files, packages, read, rootManifest, turboConfig, turboConfigFile } = workspace;
    const relevantFiles = new Set();
    const addPattern = (pattern) => {
        const normalized = path.posix.normalize(pattern.replace(/^\.\//, ''));
        if (!/[*?]/.test(normalized)) {
            relevantFiles.add(normalized);
            return;
        }
        for (const file of files) if (path.posix.matchesGlob(file, normalized)) relevantFiles.add(file);
    };

    const generatorConfigs = files.filter(
        (file) => /\.(?:c|m)?(?:j|t)s$/.test(file) && /^\s*[\w$]+\.setGenerator\(/m.test(read(file)),
    );
    const generatorDirectories = new Set(generatorConfigs.map((file) => path.posix.dirname(file)));
    const generatedPackageDependencies = new Set();
    for (const directory of generatorDirectories) {
        for (const file of files.filter(
            (entry) => entry.startsWith(`${directory}/`) && entry.endsWith('/package.json.hbs'),
        )) {
            for (const section of read(file).matchAll(
                /"(?:dependencies|devDependencies|optionalDependencies|peerDependencies)"\s*:\s*\{([\s\S]*?)\}/g,
            )) {
                for (const [, name] of section[1].matchAll(/"([^"]+)"\s*:/g)) generatedPackageDependencies.add(name);
            }
        }
    }
    for (const field of ['dependencies', 'devDependencies']) {
        for (const name of Object.keys(rootManifest[field] ?? {})) generatedPackageDependencies.add(name);
    }
    const relevantDirectories = new Set([
        ...generatorDirectories,
        ...dependencyClosure(packages, generatedPackageDependencies),
    ]);

    for (const file of files.filter((entry) => !entry.includes('/'))) {
        if (file === 'package.json' || /(?:lock|workspace)/i.test(file)) relevantFiles.add(file);
    }
    if (turboConfigFile) {
        relevantFiles.add(turboConfigFile);
        for (const input of turboConfig.globalDependencies) addPattern(input);
    }

    const job = workflowJob(workspace, 'generator');
    if (!job) throw new Error('Could not find the generator job in a GitHub workflow.');
    relevantFiles.add(job.file);
    for (const localPath of localUses(job.source)) relevantDirectories.add(localPath);

    // The root scripts the job runs, the scripts those run in turn, and the files they pass to node.
    const scripts = rootManifest.scripts ?? {};
    const pendingScripts = Object.keys(scripts).filter((name) => {
        const escapedName = name.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
        return new RegExp(`\\bpnpm\\s+(?:run\\s+)?${escapedName}(?=\\s|$)`).test(job.source);
    });
    const visitedScripts = new Set();
    while (pendingScripts.length) {
        const name = pendingScripts.pop();
        if (visitedScripts.has(name)) continue;
        visitedScripts.add(name);
        const command = scripts[name];
        for (const [, scriptPath] of command.matchAll(/\bnode\s+([^\s"'`]+\.mjs)/g)) addPattern(scriptPath);
        for (const [, nestedName] of command.matchAll(/\bpnpm\s+(?:run\s+)?([\w:-]+)/g)) {
            if (Object.hasOwn(scripts, nestedName)) pendingScripts.push(nestedName);
        }
    }

    if (generatorConfigs.length === 0) throw new Error('Could not find the repository generator configuration.');
    return { files: relevantFiles, directories: relevantDirectories };
}
