import * as fs from 'node:fs';
import { analyzeWitUsage, type WitAnalysis } from '../wit/analysis.ts';
import { readInterfaceDeclarationOrder, readPluginImportOrder, readWitToolsDocument } from '../wit/parser.ts';
import { resolvePluginApi, resolveWitDocument } from '../wit/resolver.ts';
import type { WitApiPackage } from '../wit/types.ts';
import type { ComponentBuildOptions } from './types.ts';

/** Result of resolving the plugin's WIT world and selecting its imported API operations. */
export interface ComponentWitAnalysis {
    /** Resolved methods, WASI adapters, feature flags, and event fields selected for the bundle. */
    analysis: WitAnalysis;
    /** Pumpkin API package containing the interfaces imported by the plugin world. */
    apiPackage: WitApiPackage;
}

/** Resolve the prepared WIT world and select operations from build inputs and the bundled source. */
export function analyzeComponentWit(options: ComponentBuildOptions): ComponentWitAnalysis {
    const document = readWitToolsDocument(options.wit);
    const imports = readPluginImportOrder(options.wit);
    const resolved = resolveWitDocument(document, readInterfaceDeclarationOrder(options.wit));
    const bundleSource = fs.readFileSync(options.bundle, 'utf8');
    const apiPackage = resolvePluginApi(resolved, imports);
    const analysis = analyzeWitUsage(resolved, {
        bundleSource,
        pluginImportOrder: imports,
        wasiImports: options.wasiImports,
        ...(options.wasiMethods === undefined ? {} : { wasiMethods: options.wasiMethods }),
        ...(options.apiMethods === undefined ? {} : { apiMethods: options.apiMethods })
    });
    return { analysis, apiPackage };
}
