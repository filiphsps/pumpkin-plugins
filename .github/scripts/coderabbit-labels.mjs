// Checks .github/labels.yml and generates the CodeRabbit label instructions in .coderabbit.yaml.
//
//   node .github/scripts/coderabbit-labels.mjs              update .coderabbit.yaml
//   node .github/scripts/coderabbit-labels.mjs --check      fail when .coderabbit.yaml is out of date
//   node .github/scripts/coderabbit-labels.mjs --manifest <file>
//                                                          write the catalog for label sync
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { parse, stringify } from 'yaml';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const labelsFile = '.github/labels.yml';
const codeRabbitFile = '.coderabbit.yaml';
const syncedFields = ['name', 'color', 'description', 'aliases'];
const allowedFields = new Set([...syncedFields, 'ai_apply_when']);
/** CodeRabbit rejects longer labeling instructions. */
const maxInstructionLength = 3000;
const sectionStart = '    labeling_instructions:\n';
const sectionEnd = '    mutually_exclusive_groups:\n';
const sectionIndent = ' '.repeat(8);

function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function pluginPackageDirectories(root) {
    const directories = [];
    for (const entry of await readdir(path.join(root, 'packages'), { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        try {
            const manifest = JSON.parse(
                await readFile(path.join(root, 'packages', entry.name, 'package.json'), 'utf8'),
            );
            if (manifest.pumpkinPlugin) directories.push(entry.name);
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
    }
    return directories.sort();
}

/**
 * Reads and checks the label catalog: field names, unique names, CodeRabbit instructions, and one
 * `plugin:` label for each plugin package, naming `packages/<dir>/` in its `ai_apply_when`.
 */
export async function readLabelCatalog(root = repositoryRoot) {
    const labels = parse(await readFile(path.join(root, labelsFile), 'utf8'));
    if (!Array.isArray(labels) || !labels.every(isRecord)) {
        return { labels: [], errors: [`${labelsFile} must be a YAML array of label mappings.`] };
    }

    const errors = [];
    const names = new Set();
    const labelledPlugins = new Map();
    for (const label of labels) {
        const { name, color, ai_apply_when: instructions } = label;
        if (typeof name !== 'string' || typeof color !== 'string') {
            errors.push(`Every label in ${labelsFile} needs a name and a color.`);
            continue;
        }
        const unknown = Object.keys(label).filter((field) => !allowedFields.has(field));
        if (unknown.length > 0) errors.push(`${name} has unsupported fields: ${unknown.join(', ')}.`);
        if (names.has(name)) errors.push(`${name} is defined more than once.`);
        names.add(name);
        if (instructions !== undefined && (typeof instructions !== 'string' || instructions.trim() === '')) {
            errors.push(`ai_apply_when for ${name} must be a non-empty string.`);
        } else if (instructions?.length > maxInstructionLength) {
            errors.push(`ai_apply_when for ${name} exceeds ${maxInstructionLength} characters.`);
        }
        if (name.startsWith('plugin: ')) {
            const directory = /\bpackages\/([^/\s]+)\//.exec(instructions ?? '')?.[1];
            if (directory) labelledPlugins.set(directory, name);
            else errors.push(`${name} must name its plugin as packages/<dir>/ in ai_apply_when.`);
        }
    }

    const plugins = await pluginPackageDirectories(root);
    for (const directory of plugins) {
        if (!labelledPlugins.has(directory)) errors.push(`packages/${directory} has no "plugin: <Name>" label.`);
    }
    for (const [directory, name] of labelledPlugins) {
        if (!plugins.includes(directory))
            errors.push(`${name} points at packages/${directory}, which is not a plugin.`);
    }

    return { labels, errors };
}

function renderCodeRabbitConfig(contents, labels) {
    const instructions = labels
        .filter((label) => label.ai_apply_when !== undefined)
        .map((label) => ({ label: label.name, instructions: label.ai_apply_when }));
    if (instructions.length === 0) throw new Error('At least one label must define ai_apply_when.');

    const start = contents.indexOf(sectionStart);
    const end = contents.indexOf(sectionEnd);
    if (start < 0 || end < start || contents.indexOf(sectionStart, start + 1) >= 0) {
        throw new Error(
            `${codeRabbitFile} must contain reviews.labeling_instructions followed by mutually_exclusive_groups.`,
        );
    }

    const rendered = stringify(instructions, { lineWidth: 120 - sectionIndent.length })
        .trimEnd()
        .split('\n')
        .map((line) => `${sectionIndent}${line}`)
        .join('\n');
    const updated = `${contents.slice(0, start)}${sectionStart}${rendered}\n${contents.slice(end)}`;

    const before = parse(contents);
    const after = parse(updated);
    before.reviews.labeling_instructions = instructions;
    if (!isDeepStrictEqual(before, after)) {
        throw new Error(`Generated ${codeRabbitFile} changed more than reviews.labeling_instructions.`);
    }
    return updated;
}

/**
 * Regenerates `reviews.labeling_instructions` in `.coderabbit.yaml` from the label catalog. With
 * `check`, reports an out-of-date file as an error instead of writing it.
 */
export async function syncCodeRabbitLabels({ root = repositoryRoot, check = false } = {}) {
    const { labels, errors } = await readLabelCatalog(root);
    if (errors.length > 0) return { errors, changed: false };

    const file = path.join(root, codeRabbitFile);
    const contents = await readFile(file, 'utf8');
    const updated = renderCodeRabbitConfig(contents, labels);
    const changed = updated !== contents;
    if (changed && check) {
        return {
            errors: [`${codeRabbitFile} is out of date; run node .github/scripts/coderabbit-labels.mjs.`],
            changed,
        };
    }
    if (changed) await writeFile(file, updated);
    return { errors: [], changed };
}

/**
 * Writes the label catalog without CodeRabbit-only fields, in the format the label sync action reads.
 * Returns the catalog errors; nothing is written when there are any.
 */
export async function writeLabelManifest({ root = repositoryRoot, file }) {
    const { labels, errors } = await readLabelCatalog(root);
    if (errors.length === 0) {
        const manifest = labels.map((label) =>
            Object.fromEntries(syncedFields.filter((field) => field in label).map((field) => [field, label[field]])),
        );
        await writeFile(file, stringify(manifest));
    }
    return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    const { values } = parseArgs({ options: { check: { type: 'boolean' }, manifest: { type: 'string' } } });
    const errors = values.manifest
        ? await writeLabelManifest({ file: values.manifest })
        : (await syncCodeRabbitLabels({ check: values.check })).errors;
    for (const error of errors) console.error(`- ${error}`);
    if (errors.length > 0) process.exitCode = 1;
}
