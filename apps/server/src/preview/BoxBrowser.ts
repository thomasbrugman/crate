import { PreviewBoxBrowserUnavailableError, type ThreadId } from "@t3tools/contracts";
import { BoxApi } from "@t3tools/provider-upstash-box/server";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeModule from "node:module";
import type { Browser } from "playwright-core";

import { BoxThreadResolver } from "../vcs/BoxThreadResolver.ts";

const requirePlaywright = NodeModule.createRequire(import.meta.url);
const BOX_READ_CHUNK_BYTES = 8 * 1024 * 1024;

export class BoxBrowser extends Context.Service<
  BoxBrowser,
  {
    readonly connect: (
      threadId: ThreadId,
      wake: boolean,
    ) => Effect.Effect<Browser | undefined, PreviewBoxBrowserUnavailableError>;
    readonly readFile: (
      browser: Browser,
      path: string,
      limit: number,
    ) => Effect.Effect<Buffer | null, PreviewBoxBrowserUnavailableError>;
  }
>()("t3/preview/BoxBrowser") {}

export const layer = Layer.effect(
  BoxBrowser,
  Effect.gen(function* () {
    const resolver = yield* BoxThreadResolver;
    const api = yield* BoxApi.BoxApi;
    const connections = new Map<string, Promise<Browser>>();
    const readers = new WeakMap<Browser, NonNullable<BoxApi.BoxHandle["files"]["readBase64"]>>();
    const unavailable = () => new PreviewBoxBrowserUnavailableError();

    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        await Promise.allSettled(
          [...connections.values()].map(async (connection) => (await connection).close()),
        );
      }),
    );

    return BoxBrowser.of({
      connect: Effect.fn("BoxBrowser.connect")(function* (threadId, wake) {
        const target = yield* resolver.resolveBrowser(threadId).pipe(Effect.mapError(unavailable));
        if (target === undefined) return undefined;
        if (target === null) return yield* unavailable();
        return yield* Effect.tryPromise({
          try: () => {
            const existing = connections.get(target.nativeId);
            if (existing) return existing;
            const connection = (async () => {
              const box = await api.get(target.nativeId, target.apiKey);
              if (!box.browserCdpUrl) throw unavailable();
              if ((await box.getStatus()).status === "paused") {
                if (!wake) throw unavailable();
                await box.resume();
              }
              const endpoint = await box.browserCdpUrl();
              const { chromium } = requirePlaywright(
                "playwright-core",
              ) as typeof import("playwright-core");
              const browser = await chromium.connectOverCDP(endpoint, { timeout: 15_000 });
              if (box.files.readBase64) readers.set(browser, box.files.readBase64);
              return browser;
            })();
            connections.set(target.nativeId, connection);
            const evict = () => {
              if (connections.get(target.nativeId) === connection)
                connections.delete(target.nativeId);
            };
            void connection.then((browser) => browser.once("disconnected", evict), evict);
            return connection;
          },
          catch: unavailable,
        });
      }),
      readFile: Effect.fn("BoxBrowser.readFile")((browser, path, limit) =>
        Effect.tryPromise({
          try: async () => {
            const read = readers.get(browser);
            if (!read) throw unavailable();
            const chunks: Array<Buffer> = [];
            let offset = 0;
            while (offset <= limit) {
              const length = Math.min(BOX_READ_CHUNK_BYTES, limit - offset + 1);
              const chunk = Buffer.from(await read(path, offset, length), "base64");
              offset += chunk.length;
              if (offset > limit) return null;
              chunks.push(chunk);
              if (chunk.length < length) return Buffer.concat(chunks, offset);
            }
            return null;
          },
          catch: unavailable,
        }),
      ),
    });
  }),
);
