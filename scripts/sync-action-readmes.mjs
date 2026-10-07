// Generates action README input/output tables from action.yml, keeping the action metadata as source of truth.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse } from 'yaml';

const root = process.env.PUMPKIN_PLUGINS_ROOT ?? path.resolve(import.meta.dirname, '..');
const actionsRoot = path.join(root, 'actions');
const checkOnly = process.argv.includes('--check');
const actionDirs = fs
    .readdirSync(actionsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => ['action.yml', 'action.yaml'].some((file) => fs.existsSync(path.join(actionsRoot, name, file))))
    .sort();

let hasDrift = false;
for (const name of actionDirs) {
    const actionDir = path.join(actionsRoot, name);
    const actionFile = ['action.yml', 'action.yaml'].find((file) => fs.existsSync(path.join(actionDir, file)));
    const readmePath = path.join(actionDir, 'README.md');
    if (!fs.existsSync(readmePath)) throw new Error(`actions/${name}/README.md is missing`);

    const metadata = parse(fs.readFileSync(path.join(actionDir, actionFile), 'utf8'));
    if (!metadata || typeof metadata !== 'object')
        throw new Error(`actions/${name}/${actionFile} must contain an object`);
    const readme = fs.readFileSync(readmePath, 'utf8');
    const updated = replaceSection(readme, 'inputs', renderInputs(metadata.inputs));
    const withOutputs = replaceSection(updated, 'outputs', renderOutputs(metadata.outputs));

    if (withOutputs === readme) {
        console.log(`actions/${name}/README.md input/output tables are current`);
    } else if (checkOnly) {
        hasDrift = true;
        console.error(`actions/${name}/README.md input/output tables are stale; run pnpm readme`);
    } else {
        fs.writeFileSync(readmePath, withOutputs);
        console.log(`Updated actions/${name}/README.md input/output tables`);
    }
}

if (hasDrift) process.exitCode = 1;

function replaceSection(readme, section, contents) {
    const start = `<!-- action-${section}:start -->`;
    const end = `<!-- action-${section}:end -->`;
    const pattern = new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}`);
    if (!pattern.test(readme)) throw new Error(`Action README is missing ${start} and ${end} markers`);
    return readme.replace(pattern, `${start}\n${contents}\n${end}`);
}

function renderInputs(inputs) {
    const entries = asEntries(inputs, 'inputs');
    if (entries.length === 0) return 'This action has no inputs.';
    const rows = entries.map(([name, input]) => {
        if (!input || typeof input !== 'object') throw new Error(`Input ${name} must be an object`);
        return [
            `\`${name}\``,
            input.required === true ? 'Yes' : 'No',
            Object.hasOwn(input, 'default') ? formatValue(input.default) : '',
            String(input.description ?? '')
        ];
    });
    return renderTable(['Input', 'Required', 'Default', 'Description'], rows);
}

function renderOutputs(outputs) {
    const entries = asEntries(outputs, 'outputs');
    if (entries.length === 0) return 'This action has no outputs.';
    const rows = entries.map(([name, output]) => {
        if (!output || typeof output !== 'object') throw new Error(`Output ${name} must be an object`);
        return [`\`${name}\``, String(output.description ?? '')];
    });
    return renderTable(['Output', 'Description'], rows);
}

function asEntries(value, label) {
    if (value === undefined) return [];
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be a mapping`);
    return Object.entries(value);
}

function formatValue(value) {
    if (typeof value === 'string') return codeSpan(value || '""');
    if (value === null) return codeSpan('null');
    if (typeof value === 'object') return codeSpan(JSON.stringify(value));
    return codeSpan(String(value));
}

function codeSpan(value) {
    const longestRun = Math.max(0, ...[...value.matchAll(/`+/g)].map(([run]) => run.length));
    const fence = '`'.repeat(longestRun + 1);
    const content = value.startsWith('`') || value.endsWith('`') ? ` ${value} ` : value;
    return `${fence}${content}${fence}`;
}

function renderTable(headers, rows) {
    const formatRow = (values) => `| ${values.map(escapeCell).join(' | ')} |`;
    return [formatRow(headers), formatRow(headers.map(() => '---')), ...rows.map(formatRow)].join('\n');
}

function escapeCell(value) {
    return String(value).replaceAll('|', '\\|').replaceAll('\r\n', '<br>').replaceAll('\n', '<br>');
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
