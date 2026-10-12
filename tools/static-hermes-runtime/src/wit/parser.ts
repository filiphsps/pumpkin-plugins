import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseWitToolsJson, type WitToolsDocument } from './model.ts';

/**
 * Run the pinned wasm-tools WIT JSON command for one prepared WIT world.
 *
 * @param witDir - Prepared WIT directory containing the plugin world.
 * @param options - Optional wasm-tools executable and command runner.
 * @returns The validated resolved WIT document.
 * @throws {Error} If wasm-tools is unavailable, the command fails, or its JSON is invalid.
 */
export function readWitToolsDocument(
    witDir: string,
    options: {
        /** wasm-tools executable; defaults to `WASM_TOOLS` in the process environment. */
        executable?: string;
        /** Optional command runner for tests and embedded callers. */
        run?: (executable: string, args: string[]) => string;
    } = {}
): WitToolsDocument {
    const executable = options.executable ?? process.env.WASM_TOOLS;
    if (!executable) throw new Error('WASM_TOOLS is not configured; run the Static Hermes toolchain setup first');
    const absoluteWitDir = path.resolve(witDir);
    let source: string;
    try {
        source = options.run
            ? options.run(executable, ['component', 'wit', absoluteWitDir, '--json', '--all-features'])
            : execFileSync(executable, ['component', 'wit', absoluteWitDir, '--json', '--all-features'], {
                  encoding: 'utf8',
                  maxBuffer: 64 * 1024 * 1024
              });
    } catch (error) {
        const detail = processErrorDetail(error);
        throw new Error(
            `wasm-tools component wit ${absoluteWitDir} --json --all-features failed${detail ? `: ${detail}` : ''}`,
            { cause: error }
        );
    }
    return parseWitToolsJson(source);
}

/** Read top-level plugin imports in declaration order for stable generator output. */
export function readPluginImportOrder(witDir: string): string[] {
    const pluginPath = path.join(path.resolve(witDir), 'plugin.wit');
    if (!fs.existsSync(pluginPath)) throw new Error(`Prepared WIT package has no plugin.wit at ${pluginPath}`);
    const source = fs
        .readFileSync(pluginPath, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\r\n]*/g, '');
    const world = /\bworld\s+%?plugin\s*\{/.exec(source);
    if (!world) throw new Error(`plugin.wit has no plugin world in ${path.resolve(witDir)}`);
    const open = source.indexOf('{', world.index);
    const close = matchingBrace(source, open, pluginPath);
    const body = source.slice(open + 1, close);
    return [...body.matchAll(/\bimport\s+([^;]+);/g)].map((match) => match[1]?.trim().replace(/^%/, ''));
}

/** Capture only declaration order that wasm-tools' resolved JSON maps do not retain. */
export function readInterfaceDeclarationOrder(witDir: string): Map<string, InterfaceDeclarationOrder> {
    const root = path.resolve(witDir);
    const orders = new Map<string, InterfaceDeclarationOrder>();
    for (const filename of findWitFiles(root)) {
        const source = stripComments(fs.readFileSync(filename, 'utf8'));
        const pkg = packageDeclaration(source) ?? packageDeclarationForFile(root, filename);
        if (!pkg) continue;
        const separator = pkg.lastIndexOf('@');
        const packageName = separator < 0 ? pkg : pkg.slice(0, separator);
        const version = separator < 0 ? undefined : pkg.slice(separator + 1);
        for (const match of source.matchAll(/\binterface\s+%?([a-zA-Z][\w-]*)\s*\{/g)) {
            const name = match[1];
            const matchIndex = match.index;
            if (name === undefined || matchIndex === undefined) {
                throw new Error(`Could not read interface declaration in ${filename}`);
            }
            const open = matchIndex + match[0].lastIndexOf('{');
            const close = matchingBrace(source, open, filename);
            const body = source.slice(open + 1, close);
            const order: InterfaceDeclarationOrder = {
                resources: declarationNames(body, 'resource'),
                records: declarationNames(body, 'record'),
                variants: declarationNames(body, 'variant'),
                enums: declarationNames(body, 'enum'),
                flags: declarationNames(body, 'flags'),
                types: declarationNames(body, 'type'),
                escapedNames: captureNames(body, /%([a-zA-Z][\w-]*)/g)
            };
            orders.set(`${packageName}/${name}${version ? `@${version}` : ''}`, order);
        }
    }
    return orders;
}

/** Source declaration names grouped by WIT declaration kind in their original order. */
export interface InterfaceDeclarationOrder {
    /** Resource names in source declaration order. */
    resources: string[];
    /** Record names in source declaration order. */
    records: string[];
    /** Variant names in source declaration order. */
    variants: string[];
    /** Enum names in source declaration order. */
    enums: string[];
    /** Flags names in source declaration order. */
    flags: string[];
    /** Type-alias names in source declaration order. */
    types: string[];
    /** Escaped WIT identifiers encountered in the interface declaration. */
    escapedNames: string[];
}

function packageDeclaration(source: string): string | undefined {
    return /\bpackage\s+([^;]+);/.exec(stripComments(source))?.[1]?.trim();
}

function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\r\n]*/g, '');
}

function packageDeclarationForFile(root: string, filename: string): string | undefined {
    let directory = path.dirname(filename);
    while (directory === root || directory.startsWith(`${root}${path.sep}`)) {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            if (!entry.isFile() || !entry.name.endsWith('.wit')) continue;
            const source = fs.readFileSync(path.join(directory, entry.name), 'utf8');
            const pkg = packageDeclaration(source);
            if (pkg) return pkg;
        }
        if (directory === root) return undefined;
        directory = path.dirname(directory);
    }
    return undefined;
}

function declarationNames(body: string, keyword: string): string[] {
    const pattern = new RegExp(`\\b${keyword}\\s+%?([a-zA-Z][\\w-]*)`, 'g');
    return captureNames(body, pattern);
}

function captureNames(source: string, pattern: RegExp): string[] {
    return [...source.matchAll(pattern)].map((match) => match[1]).filter((name): name is string => name !== undefined);
}

function findWitFiles(directory: string): string[] {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) return findWitFiles(entryPath);
        return entry.isFile() && entry.name.endsWith('.wit') ? [entryPath] : [];
    });
}

function matchingBrace(source: string, open: number, filename: string): number {
    let depth = 1;
    for (let index = open + 1; index < source.length; index += 1) {
        if (source[index] === '{') depth += 1;
        else if (source[index] === '}' && --depth === 0) return index;
    }
    throw new Error(`plugin world is not closed in ${filename}`);
}

function processErrorDetail(error: unknown): string {
    if (typeof error !== 'object' || error === null || !('stderr' in error)) return '';
    const stderr = error.stderr;
    if (typeof stderr === 'string') return stderr.trim();
    if (stderr instanceof Uint8Array) return new TextDecoder().decode(stderr).trim();
    return '';
}
