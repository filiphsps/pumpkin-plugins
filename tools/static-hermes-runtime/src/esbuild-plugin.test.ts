import * as path from 'node:path';
import { build } from 'esbuild';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { staticHermesImportsPlugin } from './esbuild-plugin.ts';

const mocks = vi.hoisted(() => ({
    setupToolchain: vi.fn(),
    readImports: vi.fn(),
    readDocument: vi.fn(),
    readOrder: vi.fn(),
    resolveDocument: vi.fn(),
    resolveApi: vi.fn(),
    resolveWasi: vi.fn(),
    emitApi: vi.fn(),
    emitWasi: vi.fn()
}));

vi.mock('./hermes/toolchain-environment.ts', () => ({
    setupHermesToolchainEnvironment: mocks.setupToolchain
}));
vi.mock('./wit/parser.ts', () => ({
    readPluginImportOrder: mocks.readImports,
    readWitToolsDocument: mocks.readDocument,
    readInterfaceDeclarationOrder: mocks.readOrder
}));
vi.mock('./wit/resolver.ts', () => ({
    resolveWitDocument: mocks.resolveDocument,
    resolvePluginApi: mocks.resolveApi,
    resolveWasiImports: mocks.resolveWasi
}));
vi.mock('./wit/emitters.ts', () => ({ emitPumpkinFacade: mocks.emitApi, emitWasiFacade: mocks.emitWasi }));

const previousWasmTools = process.env.WASM_TOOLS;
const witDirectory = path.join(process.cwd(), 'fixtures/plugin-wit');
const apiInterface = { name: 'logging', specifier: 'pumpkin:plugin/logging@0.1.0' };
const wasiInterface = {
    name: 'types',
    packageName: 'wasi:filesystem',
    specifier: 'wasi:filesystem/types@0.2.3'
};

beforeEach(() => {
    mocks.setupToolchain.mockReset().mockResolvedValue({ WASM_TOOLS: '/mock/wasm-tools' });
    mocks.readImports.mockReset().mockReturnValue([apiInterface.specifier, wasiInterface.specifier]);
    mocks.readDocument.mockReset().mockReturnValue({ id: 'document' });
    mocks.readOrder.mockReset().mockReturnValue(new Map());
    mocks.resolveDocument.mockReset().mockReturnValue({ id: 'resolved' });
    mocks.resolveApi.mockReset().mockReturnValue({ interfaces: [apiInterface] });
    mocks.resolveWasi.mockReset().mockReturnValue({ interfaces: [wasiInterface] });
    mocks.emitApi.mockReset().mockReturnValue('export const pumpkinValue = "api-facade";');
    mocks.emitWasi.mockReset().mockReturnValue('export const wasiValue = "wasi-facade";');
});

afterEach(() => {
    if (previousWasmTools === undefined) delete process.env.WASM_TOOLS;
    else process.env.WASM_TOOLS = previousWasmTools;
});

it('bundles declared Pumpkin and WASI imports through generated facades', async () => {
    const onWasiImport = vi.fn();
    const plugin = staticHermesImportsPlugin({ resolveDir: process.cwd(), witDir: witDirectory, onWasiImport });
    const result = await build({
        stdin: {
            contents: `import { pumpkinValue } from ${JSON.stringify(apiInterface.specifier)}; import { wasiValue } from ${JSON.stringify(wasiInterface.specifier)}; console.log(pumpkinValue, wasiValue);`,
            resolveDir: process.cwd(),
            sourcefile: 'plugin-entry.js'
        },
        bundle: true,
        write: false,
        plugins: [plugin],
        logLevel: 'silent'
    });

    expect(mocks.setupToolchain).toHaveBeenCalledWith({
        workspaceRoot: process.cwd(),
        includeWasiSdk: false,
        includeWitBindgen: false,
        includeWasmTools: true
    });
    expect(mocks.readDocument).toHaveBeenCalledWith(witDirectory);
    expect(onWasiImport).toHaveBeenCalledWith(wasiInterface.specifier);
    expect(result.outputFiles[0]?.text).toContain('api-facade');
    expect(result.outputFiles[0]?.text).toContain('wasi-facade');
});

it('replaces update checks in development bundles and rejects undeclared imports', async () => {
    const developmentPlugin = staticHermesImportsPlugin({
        resolveDir: process.cwd(),
        witDir: witDirectory,
        developmentMode: true
    });
    const development = await build({
        stdin: {
            contents:
                'import { registerPluginWithUpdates } from "@pumpkin-plugins/update-check"; registerPluginWithUpdates({});',
            resolveDir: process.cwd(),
            sourcefile: 'plugin-entry.js'
        },
        bundle: true,
        external: ['@pumpkinmc/pumpkin-api-ts'],
        write: false,
        plugins: [developmentPlugin],
        logLevel: 'silent'
    });
    expect(development.outputFiles[0]?.text).toContain('registerPluginWithUpdates');
    expect(development.outputFiles[0]?.text).toContain('registerPlugin');
    expect(development.outputFiles[0]?.text).not.toContain('checkForUpdates');

    const productionPlugin = staticHermesImportsPlugin({ resolveDir: process.cwd(), witDir: witDirectory });
    await expect(
        build({
            stdin: {
                contents: 'import "pumpkin:plugin/unlisted@0.1.0";',
                resolveDir: process.cwd(),
                sourcefile: 'plugin-entry.js'
            },
            bundle: true,
            write: false,
            plugins: [productionPlugin],
            logLevel: 'silent'
        })
    ).rejects.toThrow("pumpkin:plugin/unlisted@0.1.0 is not imported by the plugin's WIT world");
});
