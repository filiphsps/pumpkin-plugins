import { resourceProxySource } from './resource-proxy.mjs';

/** Wraps a Static Hermes bundle so JS module initialization failures retain their message. */
export function wrapBundleForDiagnostics(source) {
    return `try {\n${resourceProxySource}\n${source}\n} catch (error) {\n  globalThis.__pumpkinPluginInitError = error && error.stack ? String(error.stack) : String(error);\n  throw error;\n}\n`;
}
