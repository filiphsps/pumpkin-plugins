import * as fs from 'node:fs';
import * as path from 'node:path';
import { verifyWasm } from '../../../tools/signing/src/index.ts';
import { getInput, setOutput } from '../../common/src/utils.mjs';

const wasmFile = getInput('wasm-file').trim();
const pluginsManifest = getInput('plugins-manifest').trim();
const expectedPublicKey = getInput('expected-public-key').trim().toLowerCase();
const expectedPluginName = getInput('plugin-name').trim();
const expectedVersion = getInput('version').trim();

try {
    verifyPlugins();
} catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`::error::${escapeWorkflowCommand(message)}`);
    process.exitCode = 1;
}

function verifyPlugins() {
    if (Boolean(wasmFile) === Boolean(pluginsManifest)) {
        throw new Error('Set exactly one of wasm-file or plugins-manifest');
    }
    if (pluginsManifest && (expectedPluginName || expectedVersion)) {
        throw new Error('plugin-name and version can only be used with wasm-file');
    }
    if (expectedPublicKey && !/^[0-9a-f]{64}$/.test(expectedPublicKey)) {
        throw new Error('expected-public-key must be a 32-byte Ed25519 public key as 64 hexadecimal characters');
    }

    if (pluginsManifest) {
        const manifestFile = path.resolve(process.cwd(), pluginsManifest);
        const plugins = readManifest(manifestFile);
        for (const [index, plugin] of plugins.entries()) {
            verifyPlugin(plugin['wasm-file'], {
                fileLabel: `${plugin['plugin-name']} ${plugin.version}`,
                expectedName: plugin['plugin-name'],
                expectedVersion: plugin.version,
                index: index + 1
            });
        }
        setOutput('verified-count', String(plugins.length));
        console.log(`Verified ${plugins.length} Pumpkin plugin file(s).`);
        return;
    }

    const result = verifyPlugin(wasmFile, {
        fileLabel: wasmFile,
        expectedName: expectedPluginName || undefined,
        expectedVersion: expectedVersion || undefined
    });
    setOutput('verified-count', '1');
    setOutput('plugin-name', result.metadata.plugin_name);
    setOutput('version', result.metadata.version);
    setOutput('developer-name', result.metadata.dev_name);
    setOutput('public-key', result.publicKeyHex);
    setOutput('issued-at', result.metadata.issued_at);
}

function readManifest(manifestFile) {
    if (!fs.existsSync(manifestFile) || !fs.statSync(manifestFile).isFile()) {
        throw new Error(`Plugins manifest not found: ${manifestFile}`);
    }

    let plugins;
    try {
        plugins = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    } catch (error) {
        throw new Error(
            `Could not parse plugins manifest ${manifestFile}: ${error instanceof Error ? error.message : error}`
        );
    }
    if (!Array.isArray(plugins) || plugins.length === 0) {
        throw new Error(`plugins-manifest must contain a non-empty JSON array: ${manifestFile}`);
    }

    for (const [index, plugin] of plugins.entries()) {
        if (!plugin || typeof plugin !== 'object' || Array.isArray(plugin)) {
            throw new Error(`plugins-manifest entry ${index + 1} must be an object`);
        }
        if (
            typeof plugin['plugin-name'] !== 'string' ||
            !plugin['plugin-name'].trim() ||
            typeof plugin.version !== 'string' ||
            !plugin.version.trim() ||
            typeof plugin['wasm-file'] !== 'string' ||
            !plugin['wasm-file'].trim()
        ) {
            throw new Error(
                `plugins-manifest entry ${index + 1} must include non-empty string plugin-name, version, and wasm-file fields`
            );
        }
    }
    return plugins;
}

function verifyPlugin(fileName, { fileLabel, expectedName, expectedVersion, index } = {}) {
    const file = path.resolve(process.cwd(), fileName);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
        const prefix = index ? `plugins-manifest entry ${index}: ` : '';
        throw new Error(`${prefix}WASM file not found: ${file}`);
    }

    const result = verifyWasm(fs.readFileSync(file));
    const prefix = index ? `plugins-manifest entry ${index} (${fileLabel}): ` : `${fileLabel}: `;
    if (!result.signed) throw new Error(`${prefix}file is not signed${result.error ? `: ${result.error}` : ''}`);
    if (!result.valid)
        throw new Error(`${prefix}signature verification failed${result.error ? `: ${result.error}` : ''}`);
    if (expectedPublicKey && result.publicKeyHex !== expectedPublicKey) {
        throw new Error(`${prefix}signature public key does not match expected-public-key`);
    }
    if (expectedName && result.metadata.plugin_name !== expectedName) {
        throw new Error(
            `${prefix}plugin name is ${JSON.stringify(result.metadata.plugin_name)}, expected ${JSON.stringify(expectedName)}`
        );
    }
    if (expectedVersion && result.metadata.version !== expectedVersion) {
        throw new Error(
            `${prefix}version is ${JSON.stringify(result.metadata.version)}, expected ${JSON.stringify(expectedVersion)}`
        );
    }

    console.log(
        `Verified ${fileLabel}: ${result.metadata.plugin_name} ${result.metadata.version} ` +
            `(Ed25519 ${result.publicKeyHex}).`
    );
    return result;
}

function escapeWorkflowCommand(value) {
    return value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}
