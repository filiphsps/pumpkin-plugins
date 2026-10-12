import { resourceProxySource } from './resource-proxy-source.ts';

/** Wrap a plugin bundle with the diagnostic hooks expected by the Static Hermes runtime. */
export function wrapBundleForDiagnostics(source: string): string {
    return `try {\n${resourceProxySource}\n${source}\n} catch (error) {\n  globalThis.__pumpkinPluginInitError = error && error.stack ? String(error.stack) : String(error);\n  throw error;\n}\n`;
}
