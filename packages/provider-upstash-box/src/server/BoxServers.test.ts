import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as BoxApi from "./BoxApi.ts";
import { BoxExecThreadResolver, type BoxExecThread } from "./BoxExec.ts";
import * as BoxServers from "./BoxServers.ts";
import { DEV_SERVER_KEEPER_INIT, DEV_SERVER_KEEPER_PATH } from "./devServerKeeper.ts";

const threadId = ThreadId.make("servers-thread");
const thread: BoxExecThread = {
  providerThread: {
    appThreadId: threadId,
    driver: ProviderDriverKind.make("upstashBox"),
    nativeThreadRef: {
      driver: ProviderDriverKind.make("upstashBox"),
      nativeId: "box-id",
      strength: "strong",
    },
  },
  apiKey: "private-key",
  checkoutRoot: "/workspace/home/repo",
};

function fakeBox(options: { initCommand?: string; existingUrls?: ReadonlyArray<number> }) {
  const calls: Array<string> = [];
  let initCommand = options.initCommand ?? "";
  let created = 0;
  const unexpected = async (): Promise<never> => {
    throw new Error("unexpected API call");
  };
  const box: BoxApi.BoxHandle = {
    id: "box-id",
    agent: { stream: unexpected },
    exec: {
      command: async (command) => {
        calls.push(command);
        return command === `node ${DEV_SERVER_KEEPER_PATH} list`
          ? {
              exitCode: 0,
              stdout: JSON.stringify([
                { port: 5173, loopback: false, pid: 10, name: "node" },
                { port: 9229, loopback: true, pid: 11, name: "node" },
              ]),
            }
          : { exitCode: 0, stdout: "" };
      },
    },
    files: {
      write: async ({ path }) => {
        calls.push(`write ${path}`);
      },
    },
    delete: unexpected,
    resume: unexpected,
    getStatus: unexpected,
    publicUrls: {
      create: async (port) => {
        created += 1;
        calls.push(`create ${port}`);
        return {
          url: `https://box-id-${port}.preview.box.upstash.com/`,
          username: "user",
          password: `password-${created}`,
        };
      },
      list: async () => (options.existingUrls ?? []).map((port) => ({ port })),
      delete: async (port) => {
        calls.push(`delete ${port}`);
      },
    },
    initCommand: {
      get: async () => initCommand,
      set: async (command) => {
        calls.push("set init");
        initCommand = command;
      },
    },
  };
  return { box, calls, initCommand: () => initCommand };
}

const service = (box: BoxApi.BoxHandle) =>
  BoxServers.make.pipe(
    Effect.provideService(BoxExecThreadResolver, { resolve: () => Effect.succeed(thread) }),
    Effect.provideService(BoxApi.BoxApi, {
      get: async () => box,
      create: async () => box,
      list: async () => undefined,
      checkModelKey: async () => 200,
    }),
  );

it.effect(
  "publishes reachable servers once with fresh credentials and keeps loopback private",
  () =>
    Effect.gen(function* () {
      const fake = fakeBox({ existingUrls: [5173] });
      const servers = yield* service(fake.box);
      const first = yield* servers.list(threadId);
      assert.deepEqual(first.servers, [
        {
          port: 5173,
          processName: "node",
          url: "https://box-id-5173.preview.box.upstash.com/",
          auth: { username: "user", password: "password-1" },
        },
        { port: 9229, processName: "node", url: null, auth: null },
      ]);
      assert.deepEqual(yield* servers.list(threadId), first);
      // A URL left from earlier has unreadable credentials, so it is replaced once.
      assert.deepEqual(
        fake.calls.filter((call) => /^(create|delete)/.test(call)),
        ["delete 5173", "create 5173"],
      );
      assert.equal(fake.initCommand(), DEV_SERVER_KEEPER_INIT);
    }),
);

it.effect("publishes a URL once when scans overlap", () =>
  Effect.gen(function* () {
    const fake = fakeBox({ existingUrls: [5173] });
    const servers = yield* service(fake.box);
    const [first, second] = yield* Effect.all([servers.list(threadId), servers.list(threadId)], {
      concurrency: "unbounded",
    });
    assert.deepEqual(first, second);
    assert.deepEqual(
      fake.calls.filter((call) => /^(create|delete)/.test(call)),
      ["delete 5173", "create 5173"],
    );
  }),
);

it.effect("keeps an init command someone else set", () =>
  Effect.gen(function* () {
    const fake = fakeBox({ initCommand: "./start.sh" });
    yield* Effect.promise(() => BoxServers.installDevServerKeeper(fake.box));
    assert.equal(fake.initCommand(), "./start.sh");
    assert.deepEqual(fake.calls, [`write ${DEV_SERVER_KEEPER_PATH}`]);
  }),
);
