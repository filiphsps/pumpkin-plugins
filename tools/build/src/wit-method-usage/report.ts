import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';

/**
 * Collects the WIT operations and event types that plugin code uses, named as the WIT declares them.
 */
export class WitUsageReport {
    /** Set when some host calls cannot be seen, so the plugin needs full native adapters. */
    incomplete = false;
    /** Set when some event registrations are dynamic, so the plugin needs every event converter. */
    incompleteEventTypes = false;
    readonly #pumpkinMethods = new Set<string>();
    readonly #wasiMethods = new Set<string>();
    readonly #eventTypes = new Set<string>();
    readonly #witNames: ReadonlyMap<string, string>;

    /**
     * Prepares an empty report.
     *
     * @param witDir - WIT the declarations were generated from. Without it, WIT names are guessed from jco's names.
     */
    constructor(witDir: string | undefined) {
        this.#witNames = witDir === undefined ? new Map() : readWitNames(witDir);
    }

    /** Records an event type that plugin code registers by name. */
    addEventType(eventType: string): void {
        this.#eventTypes.add(eventType);
    }

    /** Records the operation of a generated WIT function or resource method declaration; ignores other declarations. */
    addOperation(declaration: ts.Declaration): void {
        const target = this.#target(declaration.getSourceFile());
        const names = operationNames(declaration);
        if (target && names) target.methods.add(target.prefix + names.map((name) => this.#witName(name)).join('.'));
    }

    /** Records the constructor of a generated WIT resource class; ignores other classes. */
    addConstructor(declaration: ts.ClassDeclaration | ts.ClassExpression): void {
        const target = this.#target(declaration.getSourceFile());
        if (target && declaration.name)
            target.methods.add(`${target.prefix}${this.#witName(declaration.name.text)}.constructor`);
    }

    /** Returns the sorted selection, or `undefined` when some host calls cannot be seen. */
    result() {
        if (this.incomplete) return undefined;
        return {
            pumpkinMethods: [...this.#pumpkinMethods].sort(),
            wasiMethods: [...this.#wasiMethods].sort(),
            eventTypes: this.incompleteEventTypes ? undefined : [...this.#eventTypes].sort(),
        };
    }

    /** Returns where operations declared in `source` belong, or `undefined` when it isn't generated WIT. */
    #target(source: ts.SourceFile): { methods: Set<string>; prefix: string } | undefined {
        const wasiSpecifier = wasiModuleSpecifier(source);
        if (wasiSpecifier) return { methods: this.#wasiMethods, prefix: `${wasiSpecifier}#` };
        const interfaceName = pumpkinInterfaceName(source.fileName);
        return interfaceName ? { methods: this.#pumpkinMethods, prefix: `${interfaceName}.` } : undefined;
    }

    /** Maps a jco name to its declared WIT name. */
    #witName(name: string): string {
        return this.#witNames.get(name) || guessWitName(name);
    }
}

/** Checks whether a source file holds generated declarations for a Pumpkin interface or a WASI module. */
export function isWitDeclarationFile(source: ts.SourceFile): boolean {
    return pumpkinInterfaceName(source.fileName) !== undefined || wasiModuleSpecifier(source) !== undefined;
}

/** Returns the jco names of a declared function, or of a method's resource and the method. */
function operationNames(declaration: ts.Declaration): string[] | undefined {
    if (ts.isFunctionDeclaration(declaration)) return declaration.name ? [declaration.name.text] : undefined;
    if (!ts.isMethodDeclaration(declaration) && !ts.isMethodSignature(declaration)) return undefined;
    const resource = declaration.parent;
    if (!ts.isIdentifier(declaration.name)) return undefined;
    if (!ts.isClassLike(resource) && !ts.isInterfaceDeclaration(resource)) return undefined;
    return resource.name ? [resource.name.text, declaration.name.text] : undefined;
}

function pumpkinInterfaceName(fileName: string): string | undefined {
    return /(?:^|[/\\])interfaces[/\\]pumpkin-plugin-([\w-]+)\.d\.ts$/.exec(fileName)?.[1];
}

function wasiModuleSpecifier(source: ts.SourceFile): string | undefined {
    for (const statement of source.statements) {
        if (
            ts.isModuleDeclaration(statement) &&
            ts.isStringLiteral(statement.name) &&
            statement.name.text.startsWith('wasi:')
        )
            return statement.name.text;
    }
    return undefined;
}

/**
 * Maps the camelCase and PascalCase names jco generates to the kebab-case names declared in WIT.
 * `guessWitName` cannot recover `get-x-y` from jco's `getXY`, so the declared names decide. A jco
 * name that two WIT identifiers share maps to an empty string, which falls back to the guess.
 */
function readWitNames(witDir: string): Map<string, string> {
    const names = new Map<string, string>();
    for (const file of fs.readdirSync(witDir, { recursive: true, encoding: 'utf8' })) {
        if (!file.endsWith('.wit')) continue;
        const source = fs.readFileSync(path.join(witDir, file), 'utf8').replace(/\/\/.*$/gm, '');
        for (const [witName] of source.matchAll(/[a-zA-Z][a-zA-Z0-9]*(?:-[a-zA-Z0-9]+)+/g)) {
            const words = witName.split('-').map((word) => word.toLowerCase());
            const pascalCase = words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join('');
            for (const jcoName of [pascalCase.charAt(0).toLowerCase() + pascalCase.slice(1), pascalCase]) {
                const known = names.get(jcoName);
                names.set(jcoName, known === undefined || known === witName ? witName : '');
            }
        }
    }
    return names;
}

function guessWitName(name: string): string {
    return name
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
        .replace(/([a-z\d])([A-Z])/g, '$1-$2')
        .toLowerCase();
}
