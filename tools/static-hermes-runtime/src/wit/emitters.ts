import type { WitAnalysis } from './analysis.ts';
import { generateWitEventDispatch } from './event-dispatch.ts';
import { generateEsmFacade, generateWasiEsmFacade } from './facades.ts';
import { generatePumpkinMethodDispatch } from './pumpkin-dispatch.ts';
import type { WitApiInterface, WitApiPackage, WitWasiInterface } from './types.ts';
import { generateWasiAdapterDispatch } from './wasi-dispatch.ts';

/** Generate the JavaScript facade for one resolved Pumpkin interface. */
export function emitPumpkinFacade(apiInterface: WitApiInterface, allInterfaces: readonly WitApiInterface[]): string {
    return generateEsmFacade(apiInterface, [...allInterfaces]);
}

/** Generate the JavaScript facade for one resolved WASI interface. */
export function emitWasiFacade(apiInterface: WitWasiInterface): string {
    return generateWasiEsmFacade(apiInterface);
}

/** Generate native Pumpkin method dispatch from the analyzed API method selection. */
export function emitPumpkinMethodDispatch(
    apiPackage: WitApiPackage,
    _bundleSource: string,
    analysis: WitAnalysis
): string {
    return generatePumpkinMethodDispatch(apiPackage, analysis);
}

/** Generate native WASI dispatch from the resolved import closure and adapter plan. */
export function emitWasiAdapterDispatch(interfaces: readonly WitWasiInterface[], analysis: WitAnalysis): string {
    return generateWasiAdapterDispatch(interfaces, analysis);
}

/** Generate native event conversion using the selected event-field plan. */
export function emitEventDispatch(apiPackage: WitApiPackage, bundleSource: string, analysis: WitAnalysis): string {
    return generateWitEventDispatch(apiPackage, bundleSource, analysis.eventFields);
}
