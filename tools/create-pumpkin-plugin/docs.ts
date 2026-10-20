import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { code, table } from '@pumpkin-plugins/docs/markdown';
import type { DocumentSpec } from '@pumpkin-plugins/docs/node';
import { parse } from 'yaml';

interface PackageManifest {
    dependencies?: Record<string, string>;
    engines?: { node?: string };
    pumpkinPlugin?: { entry?: string };
    version?: string;
}

interface RootPackage {
    devEngines?: { packageManager?: { name?: string; version?: string } };
}

interface Workflow {
    jobs?: Record<string, { 'runs-on'?: unknown }>;
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

const WORKFLOW_FILE = '.github/workflows/external-consumer.yml';

/** Reads the platform-to-runner map that the external consumer job's `runs-on` looks up. */
function platformRunners(workflow: Workflow): PlatformRow[] {
    const runsOn = requiredString(workflow.jobs?.['external-consumer']?.['runs-on'], `${WORKFLOW_FILE} runs-on`);
    const map = runsOn.match(/^\$\{\{\s*fromJSON\('(\{[^']+\})'\)\[matrix\.platform\]\s*\}\}$/)?.[1];
    if (!map) throw new Error(`${WORKFLOW_FILE}: runs-on platform map not found`);
    const rows = Object.entries(JSON.parse(map) as Record<string, unknown>).map(([platform, runner]) => ({
        platform,
        runner: requiredString(runner, `${WORKFLOW_FILE} ${platform} runner`),
    }));
    if (rows.length === 0) throw new Error(`${WORKFLOW_FILE}: runs-on platform map is empty`);
    return rows;
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

const rootPackage = readJson<RootPackage>(new URL('../../package.json', import.meta.url));
const creatorPackage = readJson<PackageManifest>(new URL('./package.json', import.meta.url));
const nodePin = requiredString(
    fs.readFileSync(new URL('../../.node-version', import.meta.url), 'utf8'),
    '.node-version',
);
const workflow = parse(fs.readFileSync(new URL(`../../${WORKFLOW_FILE}`, import.meta.url), 'utf8')) as Workflow;

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
    const satisfies = minimum ? isAtLeast(nodePin, minimum) : undefined;
    if (satisfies === false) throw new Error(`${name} requires Node ${version}, but CI pins ${nodePin}`);
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
    ['CI Node.js pin', code(nodePin)],
    ['Packed-consumer package manager', `${code(packageManagerName)} ${code(packageManagerVersion)}`],
    ...platformRunners(workflow).map(({ platform, runner }) => [`${platform} runner`, code(runner)]),
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

const templateTable = table(['Starter', 'Package version', 'Package dependencies', 'Host WIT imports'], templateRows);

// Each block carries its own source note, so the document-wide note is empty.
const documents = [
    {
        file: 'README.md',
        blocks: {
            'support-contract': `${supportNote}\n\n${table(['Contract', 'Value'], supportRows)}`,
            'template-defaults': `${templateNote}\n\n${templateTable}`,
        },
        note: '',
    },
] satisfies DocumentSpec[];

export { documents };
