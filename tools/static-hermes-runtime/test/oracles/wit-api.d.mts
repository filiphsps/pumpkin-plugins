import type {
    ResolvedWitType,
    WitApiAdapterPlan,
    WitApiInterface,
    WitApiPackage,
    WitFunction,
    WitParameter,
    WitWasiAdapterPlan,
    WitWasiInterface,
} from '../src/wit/types.ts';

/** WIT models shared by the facade and adapter generators. */
export type { WitApiInterface, WitApiPackage, WitWasiInterface } from '../src/wit/types.ts';

/** Generate the JavaScript facade for one Pumpkin API interface. */
export function generateEsmFacade(apiInterface: WitApiInterface, allInterfaces?: WitApiInterface[]): string;
/** Generate the JavaScript facade for one selected WASI interface. */
export function generateWasiEsmFacade(apiInterface: WitWasiInterface): string;
/** Generate C dispatch for the selected Pumpkin API methods. */
export function generateWitSimpleMethodDispatch(
    apiPackage: WitApiPackage,
    bundleSource?: string,
    apiMethods?: string[],
    apiAdapters?: WitApiAdapterPlan[],
): string;
/** Generate C dispatch that adapts selected WASI operations to the component runtime. */
export function generateWasiAdapterDispatch(
    selectedInterfaces: WitWasiInterface[],
    allInterfaces?: WitWasiInterface[],
    usedMethods?: string[],
): string;
/** Generate C event dispatch for the event types used by the bundle. */
export function generateWitEventDispatch(apiPackage: WitApiPackage, bundleSource?: string): string;
/** Generate one operation's host function from an already-resolved adapter plan. */
export function generateWitApiFunctionForResolvedOperation(input: {
    apiPackage: WitApiPackage;
    apiInterface: WitApiInterface;
    operation: WitFunction;
    parameters: Array<WitParameter & { resolvedType: ResolvedWitType }>;
    resultType: ResolvedWitType;
    options?: {
        functionName?: string;
        apiObjectName?: string;
        propertyName?: string;
        resourceDrops?: Map<string, [string, string]>;
    };
}): string | undefined;
/** Generate the host-function branch for one resolved WASI resource method plan. */
export function generateWitResourceMethodForResolvedPlan(
    apiPackage: WitApiPackage,
    plan: WitWasiAdapterPlan,
): string | undefined;
