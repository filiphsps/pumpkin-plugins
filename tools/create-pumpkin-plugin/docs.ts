import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { code, generatedBlocks, table } from '@pumpkin-plugins/docs/markdown';
import type { DocumentSpec } from '@pumpkin-plugins/docs/node';

interface PackageManifest {
    dependencies?: Record<string, string>;
    engines?: { node?: string };
    pumpkinPlugin?: { entry?: string };
    version?: string;
}

interface RootPackage {
    devEngines?: { packageManager?: { name?: string; version?: string } };
}

interface PlatformRow {
    platform: string;
    runner: string;
}

function readJson<T>(file: URL): T {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

function requiredString(value: unknown, label: string): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error(`${label} must be a non-empty string`);
    }
    return value.trim();
}

function workflowNodeVersion(workflow: string): string {
    const versions = [...workflow.matchAll(/^\s+node-version:\s*([^\s#]+)\s*$/gm)].map((match) => match[1]);
    if (versions.length !== 1) {
        throw new Error(
            `.github/workflows/external-consumer.yml: expected one node-version pin, found ${versions.length}`,
        );
    }
    return requiredString(versions[0], '.github/workflows/external-consumer.yml node-version');
}

function parsePlatformMatrix(workflow: string): PlatformRow[] {
    const lines = workflow.split(/\r?\n/);
    const includeIndex = lines.findIndex((line) => /^\s*include:\s*$/.test(line));
    if (includeIndex < 0) throw new Error('.github/workflows/external-consumer.yml: matrix include list not found');

    const includeIndent = lines[includeIndex].search(/\S/);
    const rows: PlatformRow[] = [];
    let pendingPlatform: string | undefined;

    for (const line of lines.slice(includeIndex + 1)) {
        if (line.trim().length === 0 || line.trim().startsWith('#')) continue;
        const indent = line.search(/\S/);
        if (indent <= includeIndent) break;

        const content = line.trim();
        const platform = content.match(/^[-]\s+platform:\s*(.+)$/);
        if (platform) {
            if (pendingPlatform !== undefined) {
                throw new Error(`.github/workflows/external-consumer.yml: ${pendingPlatform} has no runner`);
            }
            pendingPlatform = yamlValue(platform[1], 'platform');
            continue;
        }

        const runner = content.match(/^os:\s*(.+)$/);
        if (runner && pendingPlatform !== undefined) {
            rows.push({ platform: pendingPlatform, runner: yamlValue(runner[1], `${pendingPlatform} runner`) });
            pendingPlatform = undefined;
        }
    }

    if (pendingPlatform !== undefined) {
        throw new Error(`.github/workflows/external-consumer.yml: ${pendingPlatform} has no runner`);
    }

    const declaredPlatforms = [...workflow.matchAll(/^\s+-\s+platform:/gm)].length;
    if (rows.length === 0 || rows.length !== declaredPlatforms) {
        throw new Error(
            `.github/workflows/external-consumer.yml: parsed ${rows.length} platform rows from ${declaredPlatforms} declarations`,
        );
    }

    return rows;
}

function yamlValue(value: string | undefined, label: string): string {
    const unquoted = requiredString(value, `.github/workflows/external-consumer.yml ${label}`).replace(
        /^(['"])(.*)\1$/,
        '$2',
    );
    return requiredString(unquoted, `.github/workflows/external-consumer.yml ${label}`);
}

function nodeRequirementRows(requirements: Array<{ name: string; version: string }>): string[][] {
    const grouped = new Map<string, string[]>();
    for (const requirement of requirements) {
        const owners = grouped.get(requirement.version) ?? [];
        owners.push(requirement.name);
        grouped.set(requirement.version, owners);
    }

    return [...grouped.entries()].map(([version, owners]) => [`Node.js minimum (${owners.join(', ')})`, code(version)]);
}

function templateLabel(name: string): string {
    const labels: Record<string, string> = { javascript: 'JavaScript', typescript: 'TypeScript' };
    return labels[name] ?? name.replace(/^./, (first) => first.toUpperCase());
}

function versionParts(value: string): [number, number, number] | undefined {
    const match = value.match(/^(\d+)\.(\d+)\.(\d+)$/);
    if (!match) return undefined;
    return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isAtLeast(candidate: string, minimum: string): boolean | undefined {
    const candidateParts = versionParts(candidate);
    const minimumParts = versionParts(minimum);
    if (!candidateParts || !minimumParts) return undefined;
    for (let index = 0; index < candidateParts.length; index++) {
        if (candidateParts[index] !== minimumParts[index]) {
            return (candidateParts[index] ?? 0) > (minimumParts[index] ?? 0);
        }
    }
    return true;
}

function updatePassage(source: string, current: string, next: string, label: string, recognized = next): string {
    if (source.split(/\r?\n/).includes(recognized)) return source;
    const occurrences = source.split(current).length - 1;
    if (occurrences !== 1) throw new Error(`${label}: expected one source passage, found ${occurrences}`);
    return source.replace(current, next);
}

function updateBlock(source: string, name: string, body: string, note: string): string {
    const matches = generatedBlocks(source).filter((block) => block.name === name && block.markers === 'docs');
    if (matches.length !== 1) throw new Error(`Expected one generated block named ${name}, found ${matches.length}`);
    const block = matches[0];
    const begin = `<!-- docs:begin ${name} -->`;
    const end = `<!-- docs:end ${name} -->`;
    return `${source.slice(0, block.start)}${begin}\n${note}\n\n${body}\n${end}${source.slice(block.end)}`;
}

const rootPackage = readJson<RootPackage>(new URL('../../package.json', import.meta.url));
const creatorPackage = readJson<PackageManifest>(new URL('./package.json', import.meta.url));
const nodePin = requiredString(
    fs.readFileSync(new URL('../../.node-version', import.meta.url), 'utf8'),
    '.node-version',
);
const workflow = fs.readFileSync(new URL('../../.github/workflows/external-consumer.yml', import.meta.url), 'utf8');
const workflowNode = workflowNodeVersion(workflow);
if (workflowNode !== nodePin) {
    throw new Error(`External-consumer Node pin (${workflowNode}) does not match .node-version (${nodePin})`);
}

const templateRoot = fileURLToPath(new URL('./templates/', import.meta.url));
const templateNames = fs
    .readdirSync(templateRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
if (templateNames.length === 0) throw new Error('templates/ must contain at least one starter directory');

const templateManifests = new Map(
    templateNames.map((templateName) => [
        templateName,
        readJson<PackageManifest>(new URL(`./templates/${templateName}/package.json`, import.meta.url)),
    ]),
);
const nodeRequirements = [
    {
        name: 'creator CLI',
        version: requiredString(creatorPackage.engines?.node, 'creator package.json engines.node'),
    },
    ...templateNames.map((templateName) => {
        const manifest = templateManifests.get(templateName);
        if (!manifest) throw new Error(`${templateName}/package.json could not be loaded`);
        return {
            name: `${templateLabel(templateName)} starter`,
            version: requiredString(manifest.engines?.node, `${templateName} package.json engines.node`),
        };
    }),
];

for (const { name, version } of nodeRequirements) {
    const minimum = version.match(/^>=(\d+\.\d+\.\d+)$/)?.[1];
    const satisfies = minimum ? isAtLeast(workflowNode, minimum) : undefined;
    if (satisfies === false) throw new Error(`${name} requires Node ${version}, but CI pins ${workflowNode}`);
}

const packageManagerName = requiredString(
    rootPackage.devEngines?.packageManager?.name,
    'package.json devEngines.packageManager.name',
);
if (packageManagerName !== 'pnpm') throw new Error(`Expected pnpm CI, found ${packageManagerName}`);
const packageManagerVersion = requiredString(
    rootPackage.devEngines?.packageManager?.version,
    'package.json devEngines.packageManager.version',
);

const supportRows = [
    ...nodeRequirementRows(nodeRequirements),
    ['CI Node.js pin', code(workflowNode)],
    ['Packed-consumer package manager', `${code(packageManagerName)} ${code(packageManagerVersion)}`],
    ...parsePlatformMatrix(workflow).map(({ platform, runner }) => [`${platform} runner`, code(runner)]),
];

const templateRows = templateNames.map((templateName) => {
    const templateDirectory = path.join(templateRoot, templateName);
    const manifest = templateManifests.get(templateName);
    if (!manifest) throw new Error(`${templateName}/package.json could not be loaded`);
    const entry = requiredString(manifest.pumpkinPlugin?.entry, `${templateName} package.json pumpkinPlugin.entry`);
    const entrySource = fs.readFileSync(path.join(templateDirectory, entry), 'utf8');
    const imports = [...new Set([...entrySource.matchAll(/pumpkin:[^'"\s]+/g)].map((match) => match[0]))].sort();
    if (imports.length === 0) throw new Error(`${templateName}/${entry} must declare a versioned Pumpkin WIT import`);

    const packageVersion = requiredString(manifest.version, `${templateName} package.json version`);
    requiredString(
        manifest.dependencies?.['@pumpkin-plugins/pumpkin-api'],
        `${templateName} package.json @pumpkin-plugins/pumpkin-api dependency`,
    );
    const dependencies = Object.entries(manifest.dependencies ?? {})
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, version]) => code(`${name}@${version}`))
        .join(', ');
    return [templateLabel(templateName), code(packageVersion), dependencies, imports.map(code).join(', ')];
});

const supportNote =
    '<!-- Generated from the creator and template manifests, .node-version, and .github/workflows/external-consumer.yml. Run `pnpm --filter create-pumpkin-plugin readme`. -->';
const templateNote =
    '<!-- Generated from templates/*/package.json and each starter entry point. Run `pnpm --filter create-pumpkin-plugin readme`. -->';

const documents = [
    {
        file: 'README.md',
        transform(source) {
            let next = updatePassage(
                source,
                'Create a minimal standalone Pumpkin plugin in TypeScript or JavaScript. The CLI requires Node.js `24.21.0` or newer.',
                'Create a minimal standalone Pumpkin plugin in TypeScript or JavaScript.',
                'README introduction',
            );
            next = updatePassage(
                next,
                "These launch forms follow the official [pnpm create](https://pnpm.io/cli/create), [npm init](https://docs.npmjs.com/cli/v11/commands/npm-init/), [Yarn Classic create](https://classic.yarnpkg.com/en/docs/cli/create/), [Yarn Modern CLI migration guide](https://yarnpkg.com/migration/guide#cli-changes), and [Bun create](https://bun.sh/docs/runtime/templating/create) references. The repository's packed-consumer CI contract validates pnpm only; the other rows document invocation syntax.",
                'These launch forms follow the official [pnpm create](https://pnpm.io/cli/create), [npm init](https://docs.npmjs.com/cli/v11/commands/npm-init/), [Yarn Classic create](https://classic.yarnpkg.com/en/docs/cli/create/), [Yarn Modern CLI migration guide](https://yarnpkg.com/migration/guide#cli-changes), and [Bun create](https://bun.sh/docs/runtime/templating/create) references.',
                'README package-manager examples',
            );
            next = updatePassage(
                next,
                "Add `--skip-install` to create the files without installing packages. Existing destinations are rejected and left untouched. Templates depend on `@pumpkin-plugins/pumpkin-api` and `@pumpkin-plugins/build`; they do not include the monorepo's `plugin-kit` scaffold.",
                "Add `--skip-install` to create the files without installing packages. Existing destinations are rejected and left untouched. When launched by a supported package manager, the creator uses it to install dependencies. If it cannot detect one, it prints pnpm commands. Generated projects do not include the monorepo's `plugin-kit` scaffold.",
                'README template dependencies',
            );
            next = updatePassage(
                next,
                '## Node.js and package manager support\n\nThe generator uses Node.js type stripping and requires Node `24.21.0` or newer. It runs the package manager entrypoint that launched it when installing dependencies; otherwise use the commands it prints after creation. The packed-consumer CI matrix targets pnpm `12.11.2` on Linux x64, macOS arm64 and Windows x64.',
                '## Node.js and CI support\n\n<!-- docs:begin support-contract -->\n<!-- docs:end support-contract -->',
                'README Node.js and CI support',
                '## Node.js and CI support',
            );
            next = updatePassage(
                next,
                '## API and ABI versions\n\nThe templates start with package version `0.1.0` and Pumpkin plugin WIT ABI `0.1.0`. These versions are separate. Keep the API package and Pumpkin server ABI aligned when upgrading.',
                '## Starter package defaults\n\n<!-- docs:begin template-defaults -->\n<!-- docs:end template-defaults -->\n\nThe npm package dependency range and host WIT interface version identify separate compatibility layers. See the [ABI and runtime guide](../../docs/plugin-api/abi-and-runtime.md) for compatibility with Pumpkin server releases.',
                'README template defaults',
                '## Starter package defaults',
            );
            next = updateBlock(next, 'support-contract', table(['Contract', 'Value'], supportRows), supportNote);
            return updateBlock(
                next,
                'template-defaults',
                table(['Starter', 'Package version', 'Package dependencies', 'Host WIT imports'], templateRows),
                templateNote,
            );
        },
    },
] satisfies DocumentSpec[];

export { documents };
