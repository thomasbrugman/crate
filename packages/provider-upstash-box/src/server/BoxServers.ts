import {
  type BoxDevServer,
  type BoxDevServerList,
  PreviewBoxServersError,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as BoxApi from "./BoxApi.ts";
import { BoxExecThreadResolver } from "./BoxExec.ts";
import {
  DEV_SERVER_KEEPER_INIT,
  DEV_SERVER_KEEPER_PATH,
  devServerKeeper,
} from "./devServerKeeper.ts";
import { isUpstashBoxDriver } from "../harnesses.ts";

const Listeners = Schema.Array(
  Schema.Struct({
    port: Schema.Int,
    loopback: Schema.Boolean,
    name: Schema.NullOr(Schema.String),
  }),
);
const decodeListeners = Schema.decodeUnknownSync(Schema.fromJsonString(Listeners));

/**
 * Installs the in-Box keeper that records running servers and restarts them when the Box wakes.
 * A Box whose init command someone else set keeps it.
 */
export async function installDevServerKeeper(box: BoxApi.BoxHandle): Promise<void> {
  if (!box.initCommand) return;
  await box.files.write({ path: DEV_SERVER_KEEPER_PATH, content: devServerKeeper });
  const current = (await box.initCommand.get()).trim();
  if (current && current !== DEV_SERVER_KEEPER_INIT) return;
  if (!current) await box.initCommand.set(DEV_SERVER_KEEPER_INIT);
  // The init command first runs on the next wake; start the watcher now.
  await box.exec.command(DEV_SERVER_KEEPER_INIT);
}

export class BoxServers extends Context.Service<
  BoxServers,
  {
    readonly list: (threadId: ThreadId) => Effect.Effect<BoxDevServerList, PreviewBoxServersError>;
  }
>()("@t3tools/provider-upstash-box/server/BoxServers") {}

export const make = Effect.gen(function* () {
  const resolver = yield* BoxExecThreadResolver;
  const api = yield* BoxApi.BoxApi;
  const installed = new Set<string>();
  // Credentials are only returned when a URL is created, so they live for this server's lifetime.
  const urls = new Map<string, BoxApi.BoxPublicUrl>();

  const publishing = new Map<string, Promise<void>>();

  const publishMissing = async (box: BoxApi.BoxHandle, ports: ReadonlyArray<number>) => {
    const publicUrls = box.publicUrls;
    if (!publicUrls) return;
    const missing = ports.filter((port) => !urls.has(`${box.id}:${port}`));
    if (missing.length === 0) return;
    const existing = new Set((await publicUrls.list()).map((entry) => entry.port));
    for (const port of missing) {
      // An existing URL's credentials cannot be read back; replace it to get fresh ones.
      if (existing.has(port)) await publicUrls.delete(port);
      urls.set(`${box.id}:${port}`, await publicUrls.create(port));
    }
  };

  // Concurrent scans would each replace the URL and hand out credentials the other revoked.
  const publish = (box: BoxApi.BoxHandle, ports: ReadonlyArray<number>) => {
    const next = (publishing.get(box.id) ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => publishMissing(box, ports));
    publishing.set(box.id, next);
    const settle = () => {
      if (publishing.get(box.id) === next) publishing.delete(box.id);
    };
    next.then(settle, settle);
    return next;
  };

  return BoxServers.of({
    list: Effect.fn("BoxServers.list")(function* (threadId) {
      const fail = (reason: PreviewBoxServersError["reason"]) =>
        new PreviewBoxServersError({ reason });
      const thread = yield* resolver
        .resolve(threadId)
        .pipe(Effect.mapError(() => fail("box-unavailable")));
      const persisted = thread?.providerThread;
      const nativeId = persisted?.nativeThreadRef?.nativeId;
      if (
        !thread ||
        !persisted ||
        (!isUpstashBoxDriver(persisted.driver) && persisted.driver !== "upstashBox") ||
        !nativeId
      )
        return yield* fail("not-box-thread");
      const box = yield* Effect.tryPromise({
        try: () => api.get(nativeId, thread.apiKey),
        catch: () => fail("box-unavailable"),
      });
      const servers = yield* Effect.tryPromise({
        try: async (): Promise<ReadonlyArray<BoxDevServer>> => {
          if (!installed.has(box.id)) {
            await installDevServerKeeper(box);
            installed.add(box.id);
          }
          const result = await box.exec.command(`node ${DEV_SERVER_KEEPER_PATH} list`);
          if (result.exitCode !== 0) throw new Error("Box server scan failed.");
          const listeners = decodeListeners(result.stdout);
          await publish(
            box,
            listeners.filter((server) => !server.loopback).map((server) => server.port),
          );
          return listeners.map((server) => {
            const published = server.loopback ? undefined : urls.get(`${box.id}:${server.port}`);
            return {
              port: server.port,
              processName: server.name?.trim() || null,
              url: published?.url ?? null,
              auth: published
                ? { username: published.username, password: published.password }
                : null,
            };
          });
        },
        // SDK errors can carry request headers, so only the reason leaves this boundary.
        catch: (error) => fail(BoxApi.isMissingBox(error) ? "box-unavailable" : "scan-failed"),
      });
      return { servers };
    }),
  });
});

export const layer = Layer.effect(BoxServers, make).pipe(Layer.provide(BoxApi.layer));
