import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { analyzeComponentWit } from './analyze.ts';
import type { ComponentBuildOptions } from './types.ts';

const mocks = vi.hoisted(() => ({
    analyzeUsage: vi.fn(),
    readImports: vi.fn(),
    readDocument: vi.fn(),
    readOrder: vi.fn(),
    resolveDocument: vi.fn(),
    resolveApi: vi.fn()
}));

vi.mock('../wit/analysis.ts', () => ({ analyzeWitUsage: mocks.analyzeUsage }));
vi.mock('../wit/parser.ts', () => ({
    readInterfaceDeclarationOrder: mocks.readOrder,
    readPluginImportOrder: mocks.readImports,
    readWitToolsDocument: mocks.readDocument
}));
vi.mock('../wit/resolver.ts', () => ({
    resolvePluginApi: mocks.resolveApi,
    resolveWitDocument: mocks.resolveDocument
}));

let root = '';

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'static-hermes-analyze-'));
    mocks.analyzeUsage.mockReset().mockReturnValue({ apiMethods: ['logging.log'] });
    mocks.readImports.mockReset().mockReturnValue(['pumpkin:plugin/logging@0.1.0']);
    mocks.readDocument.mockReset().mockReturnValue({ id: 'wit-document' });
    mocks.readOrder.mockReset().mockReturnValue(new Map([['logging', ['log']]]));
    mocks.resolveDocument.mockReset().mockReturnValue({ id: 'resolved-document' });
    mocks.resolveApi.mockReset().mockReturnValue({ packageName: 'pumpkin:plugin', interfaces: [] });
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

it('resolves WIT inputs without reading the component bundle for operation selection', () => {
    const bundle = path.join(root, 'bundle.js');
    const options: ComponentBuildOptions = {
        bundle,
        wit: path.join(root, 'wit'),
        output: path.join(root, 'plugin.wasm'),
        developmentMode: false,
        wasiImports: []
    };

    const result = analyzeComponentWit(options);

    const document = { id: 'wit-document' };
    const resolved = { id: 'resolved-document' };
    const imports = ['pumpkin:plugin/logging@0.1.0'];
    expect(mocks.readDocument).toHaveBeenCalledWith(options.wit);
    expect(mocks.readImports).toHaveBeenCalledWith(options.wit);
    expect(mocks.resolveDocument).toHaveBeenCalledWith(document, expect.any(Map));
    expect(mocks.resolveApi).toHaveBeenCalledWith(resolved, imports);
    expect(mocks.analyzeUsage).toHaveBeenCalledWith(resolved, {
        pluginImportOrder: imports,
        wasiImports: []
    });
    expect(result).toEqual({
        apiPackage: { packageName: 'pumpkin:plugin', interfaces: [] },
        analysis: { apiMethods: ['logging.log'] }
    });
});

it('forwards explicit operation selections without collapsing empty lists to inferred selection', () => {
    const bundle = path.join(root, 'bundle.js');
    const options: ComponentBuildOptions = {
        bundle,
        wit: path.join(root, 'wit'),
        output: path.join(root, 'plugin.wasm'),
        developmentMode: false,
        wasiImports: ['wasi:filesystem/types@0.2.3'],
        wasiMethods: [],
        apiMethods: []
    };

    analyzeComponentWit(options);

    expect(mocks.analyzeUsage).toHaveBeenCalledWith(
        { id: 'resolved-document' },
        expect.objectContaining({
            wasiImports: options.wasiImports,
            wasiMethods: [],
            apiMethods: []
        })
    );
});

it('forwards statically selected event variants to WIT analysis', () => {
    const options: ComponentBuildOptions = {
        bundle: path.join(root, 'bundle.js'),
        wit: path.join(root, 'wit'),
        output: path.join(root, 'plugin.wasm'),
        developmentMode: false,
        wasiImports: [],
        eventTypes: ['server-tick-end-event']
    };

    analyzeComponentWit(options);

    expect(mocks.analyzeUsage).toHaveBeenCalledWith(
        { id: 'resolved-document' },
        expect.objectContaining({ eventTypes: ['server-tick-end-event'] })
    );
});
