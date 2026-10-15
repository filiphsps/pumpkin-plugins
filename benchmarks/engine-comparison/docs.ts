import { readFileSync } from 'node:fs';
import { code, table } from '@pumpkin-plugins/docs/markdown';
import type { DocumentSpec } from '@pumpkin-plugins/docs/node';
import ts from 'typescript';

interface WorkloadRow {
    area: string;
    kind: string;
    name: string;
    operationsPerSample: number;
}

type Declarations = Map<string, ts.Expression>;

const workloadSource = readTypeScript('./src/benchmark-workloads.ts');
const pluginSource = readTypeScript('./src/benchmark-plugin.ts');
const syntheticWorkloads = readSyntheticWorkloads(workloadSource);
const apiWorkloads = readApiWorkloads(pluginSource);
const workloads = [...syntheticWorkloads, ...apiWorkloads];
const syntheticCount = syntheticWorkloads.length;
const apiCount = apiWorkloads.length;

if (new Set(workloads.map(({ name }) => name)).size !== workloads.length) {
    throw new Error('Benchmark workload names must be unique');
}

const workloadRows = table(
    ['Kind', 'Workload', 'Inputs per sample', 'What it represents'],
    workloads.map(({ area, kind, name, operationsPerSample }) => [
        kind,
        code(name),
        new Intl.NumberFormat('en-US').format(operationsPerSample),
        area,
    ]),
);
const workloadSummary = `There are ${workloads.length} timed workloads: ${syntheticCount} deterministic guest-side fixtures and ${apiCount} real Pumpkin API call${apiCount === 1 ? '' : 's'}.`;
const note = '<!-- Generated from benchmark-workloads.ts and benchmark-plugin.ts. Run `pnpm readme`. -->';

/** Documentation blocks generated from the benchmark workload definitions. */
export const documents = [
    {
        file: 'docs/benchmarking.md',
        blocks: {
            'workload-summary': workloadSummary,
            'workload-inventory': workloadRows,
        },
        note,
    },
] satisfies DocumentSpec[];

function readTypeScript(path: string): ts.SourceFile {
    const file = new URL(path, import.meta.url);
    return ts.createSourceFile(file.pathname, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
}

function declarationsIn(source: ts.SourceFile): Declarations {
    const declarations = new Map<string, ts.Expression>();
    for (const statement of source.statements) {
        if (!ts.isVariableStatement(statement)) continue;
        for (const declaration of statement.declarationList.declarations) {
            if (ts.isIdentifier(declaration.name) && declaration.initializer) {
                declarations.set(declaration.name.text, declaration.initializer);
            }
        }
    }
    return declarations;
}

function readSyntheticWorkloads(source: ts.SourceFile): WorkloadRow[] {
    const declarations = declarationsIn(source);
    const registry = declarations.get('WORKLOADS');
    if (!registry || !ts.isArrayLiteralExpression(registry)) {
        throw new Error('benchmark-workloads.ts must define WORKLOADS as an array literal');
    }

    return registry.elements.map((element) => {
        if (!ts.isObjectLiteralExpression(element))
            throw new Error('Each synthetic workload must be an object literal');
        const name = readStringProperty(element, 'name');
        const area = readStringProperty(element, 'area');
        const operations = readProperty(element, 'operationsPerSample');
        if (!operations) throw new Error(`${name} must define operationsPerSample`);
        return {
            area,
            kind: 'Synthetic',
            name,
            operationsPerSample: evaluateNumber(operations, declarations),
        };
    });
}

function readApiWorkloads(source: ts.SourceFile): WorkloadRow[] {
    const declarations = declarationsIn(source);
    const workloadCalls: ts.CallExpression[] = [];
    const visit = (node: ts.Node): void => {
        if (
            ts.isCallExpression(node) &&
            ts.isIdentifier(node.expression) &&
            node.expression.text === 'measureWorkload' &&
            node.arguments.length === 5 &&
            ts.isStringLiteral(node.arguments[2]) &&
            node.arguments[2].text === 'real Pumpkin API'
        ) {
            workloadCalls.push(node);
        }
        ts.forEachChild(node, visit);
    };
    visit(source);

    if (workloadCalls.length === 0) throw new Error('benchmark-plugin.ts must register a real Pumpkin API workload');
    return workloadCalls.map((call) => {
        const [name, area, , operations] = call.arguments;
        if (!name || !ts.isStringLiteral(name) || !area || !ts.isStringLiteral(area) || !operations) {
            throw new Error('Each real Pumpkin API workload must define its name, area and input count');
        }
        return {
            area: area.text,
            kind: 'Real API',
            name: name.text,
            operationsPerSample: evaluateNumber(operations, declarations),
        };
    });
}

function readProperty(object: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
    const property = object.properties.find(
        (item): item is ts.PropertyAssignment =>
            ts.isPropertyAssignment(item) && ts.isIdentifier(item.name) && item.name.text === name,
    );
    return property?.initializer;
}

function readStringProperty(object: ts.ObjectLiteralExpression, name: string): string {
    const value = readProperty(object, name);
    if (!value || !ts.isStringLiteral(value)) throw new Error(`Each workload must define a string ${name}`);
    return value.text;
}

function evaluateNumber(expression: ts.Expression, declarations: Declarations, resolving = new Set<string>()): number {
    if (ts.isNumericLiteral(expression)) return Number(expression.text.replaceAll('_', ''));
    if (ts.isIdentifier(expression)) {
        const initializer = declarations.get(expression.text);
        if (!initializer || resolving.has(expression.text)) {
            throw new Error(`Cannot resolve workload input count value ${expression.text}`);
        }
        const nextResolving = new Set(resolving).add(expression.text);
        return evaluateNumber(initializer, declarations, nextResolving);
    }
    if (ts.isBinaryExpression(expression)) {
        const left = evaluateNumber(expression.left, declarations, resolving);
        const right = evaluateNumber(expression.right, declarations, resolving);
        switch (expression.operatorToken.kind) {
            case ts.SyntaxKind.PlusToken:
                return left + right;
            case ts.SyntaxKind.MinusToken:
                return left - right;
            case ts.SyntaxKind.AsteriskToken:
                return left * right;
            case ts.SyntaxKind.SlashToken:
                return left / right;
        }
    }
    if (ts.isPropertyAccessExpression(expression) && expression.name.text === 'length') {
        return arrayLength(expression.expression, declarations, resolving);
    }
    throw new Error(`Unsupported workload input count expression: ${expression.getText()}`);
}

function arrayLength(expression: ts.Expression, declarations: Declarations, resolving: Set<string>): number {
    if (ts.isIdentifier(expression)) {
        const initializer = declarations.get(expression.text);
        if (!initializer || resolving.has(expression.text)) {
            throw new Error(`Cannot resolve workload input array ${expression.text}`);
        }
        return arrayLength(initializer, declarations, new Set(resolving).add(expression.text));
    }
    if (ts.isArrayLiteralExpression(expression)) return expression.elements.length;
    if (ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression)) {
        const method = expression.expression.name.text;
        if (method === 'map') return arrayLength(expression.expression.expression, declarations, resolving);
        if (method === 'from') {
            const source = expression.arguments[0];
            if (source && ts.isObjectLiteralExpression(source)) {
                const length = readProperty(source, 'length');
                if (length) return evaluateNumber(length, declarations, resolving);
            }
        }
    }
    throw new Error(`Unsupported workload input array: ${expression.getText()}`);
}
