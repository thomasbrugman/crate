import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ThreadId } from "@t3tools/contracts";
import { BoxError } from "@upstash/box";
import * as Effect from "effect/Effect";

import { BoxApi, type BoxHandle } from "./BoxApi.ts";
import { BoxExecError, BoxExecThreadResolver, make, type BoxExecThread } from "./BoxExec.ts";

const threadId = ThreadId.make("exec-thread");
const thread: BoxExecThread = {
  providerThread: {
    appThreadId: threadId,
    driver: ProviderDriverKind.make("upstashBox"),
    nativeThreadRef: {
      driver: ProviderDriverKind.make("upstashBox"),
      nativeId: "persisted-box-id",
      strength: "strong",
    },
  },
  apiKey: "private-key",
  repositoryUrl: "https://github.com/owner/repo.git",
};

function service(
  options: {
    resolve?: BoxExecThreadResolver["Service"]["resolve"];
    get?: BoxApi["Service"]["get"];
    command?: BoxHandle["exec"]["command"];
  } = {},
) {
  const unexpected = async (): Promise<never> => {
    throw new Error("unexpected API call");
  };
  const box: BoxHandle = {
    id: "persisted-box-id",
    agent: { stream: unexpected },
    exec: { command: options.command ?? unexpected },
    files: { write: unexpected },
    delete: unexpected,
  };
  return make.pipe(
    Effect.provideService(BoxExecThreadResolver, {
      resolve: options.resolve ?? (() => Effect.succeed(thread)),
    }),
    Effect.provideService(BoxApi, {
      get:
        options.get ??
        (async (id, apiKey) => {
          assert.equal(id, "persisted-box-id");
          assert.equal(apiKey, "private-key");
          return box;
        }),
      create: unexpected,
      list: unexpected,
    }),
  );
}

it.effect("uses persisted Box identity, checkout defaults, and literal cwd/arguments", () =>
  Effect.gen(function* () {
    for (const [repositoryUrl, cwd, expected] of [
      [thread.repositoryUrl, undefined, "/workspace/home/repo"],
      [null, undefined, "/workspace/home"],
      [null, "/work/it's $(not-executed)", "/work/it'\\''s $(not-executed)"],
    ] as const) {
      const exec = yield* service({
        resolve: () => Effect.succeed({ ...thread, repositoryUrl }),
        command: async (command) => {
          assert.equal(command, `cd -- '${expected}' && printf '%s' 'a'\\''b; $(no)'`);
          return { exitCode: 3, stdout: "output", stderr: "error" };
        },
      });
      assert.deepEqual(
        yield* exec.run({
          threadId,
          command: "printf '%s'",
          args: ["a'b; $(no)"],
          ...(cwd ? { cwd } : {}),
        }),
        {
          exitCode: 3,
          stdout: "output",
          stderr: "error",
        },
      );
    }
    const exec = yield* service({ command: async () => ({ exitCode: 0, stdout: "" }) });
    assert.deepEqual(yield* exec.run({ threadId, command: "true" }), {
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
  }),
);

it.effect("fails closed without creating Boxes or exposing SDK errors", () =>
  Effect.gen(function* () {
    for (const [resolve, reason] of [
      [() => Effect.succeed(null), "thread_unavailable"],
      [
        () => Effect.fail(new BoxExecError({ threadId, reason: "resolve_failed" })),
        "resolve_failed",
      ],
      [
        () =>
          Effect.succeed({
            ...thread,
            providerThread: { ...thread.providerThread, driver: ProviderDriverKind.make("codex") },
          }),
        "not_box_thread",
      ],
      [
        () =>
          Effect.succeed({
            ...thread,
            providerThread: { ...thread.providerThread, appThreadId: ThreadId.make("other") },
          }),
        "not_box_thread",
      ],
      [
        () =>
          Effect.succeed({
            ...thread,
            providerThread: { ...thread.providerThread, nativeThreadRef: null },
          }),
        "not_box_thread",
      ],
      [() => Effect.succeed({ ...thread, apiKey: "" }), "box_unavailable"],
      [
        () =>
          Effect.succeed({
            ...thread,
            providerThread: {
              ...thread.providerThread,
              nativeThreadRef: { ...thread.providerThread.nativeThreadRef!, nativeId: null },
            },
          }),
        "box_unavailable",
      ],
    ] as const) {
      const exec = yield* service({
        resolve,
        get: async () => {
          throw new Error("must not get Box");
        },
      });
      const error = yield* exec.run({ threadId, command: "git status" }).pipe(Effect.flip);
      assert.equal(error.reason, reason);
      assert.notInclude(JSON.stringify(error), "private");
    }
    for (const [getFails, commandFails, reason] of [
      [true, false, "box_unavailable"],
      [false, true, "exec_failed"],
      [false, "deleted", "box_unavailable"],
      [false, false, "missing_exit_code"],
    ] as const) {
      const exec = yield* service({
        ...(getFails
          ? {
              get: async () => {
                throw new BoxError("private", 404);
              },
            }
          : {}),
        command: async () => {
          if (commandFails === "deleted") throw new BoxError("private SDK request", 404);
          if (commandFails) throw new Error("private SDK request");
          return { exitCode: null, stdout: "" };
        },
      });
      const error = yield* exec.run({ threadId, command: "git status" }).pipe(Effect.flip);
      assert.equal(error.reason, reason);
      assert.notInclude(JSON.stringify(error), "private");
    }
    const exec = yield* service({
      resolve: () => {
        throw new Error("must not resolve");
      },
    });
    for (const input of [
      { command: " " },
      { command: "pwd", cwd: "relative" },
      { command: "pwd\0" },
      { command: "echo", args: ["bad\0"] },
    ]) {
      assert.equal(
        (yield* exec.run({ threadId, ...input }).pipe(Effect.flip)).reason,
        "invalid_input",
      );
    }
  }),
);
