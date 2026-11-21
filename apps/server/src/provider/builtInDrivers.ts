import { UpstashBoxDriver, type UpstashBoxDriverEnv } from "@t3tools/provider-upstash-box/server";
import type { AnyProviderDriver } from "@t3tools/provider-core/server/driver";

export type BuiltInDriversEnv = UpstashBoxDriverEnv;
export const BUILT_IN_DRIVERS: ReadonlyArray<AnyProviderDriver<BuiltInDriversEnv>> = [
  UpstashBoxDriver,
];

export type BuiltInUsageReadersEnv = never;
export const BUILT_IN_USAGE_DRIVERS: ReadonlyArray<
  AnyProviderDriver<BuiltInDriversEnv, BuiltInUsageReadersEnv>
> = [];
