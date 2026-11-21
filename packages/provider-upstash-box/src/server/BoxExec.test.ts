import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ThreadId } from "@t3tools/contracts";
import { BoxError } from "@upstash/box";
import * as Effect from "effect/Effect";
// @effect-diagnostics-next-line nodeBuiltinImport:off - Execute shell source independently of the service under test.
import * as NodeChildProcess from "node:child_process";

import * as BoxApi from "./BoxApi.ts";
import * as BoxExec from "./BoxExec.ts";
import { BOX_HARNESS_DRIVER_KINDS } from "../harnesses.ts";

const threadId = ThreadId.make("exec-thread");
const thread: BoxExec.BoxExecThread = {
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
    resolve?: BoxExec.BoxExecThreadResolver["Service"]["resolve"];
    get?: BoxApi.BoxApi["Service"]["get"];
    command?: BoxApi.BoxHandle["exec"]["command"];
  } = {},
) {
  const unexpected = async (): Promise<never> => {
    throw new Error("unexpected API call");
  };
  const box: BoxApi.BoxHandle = {
    id: "persisted-box-id",
    agent: { stream: unexpected },
    exec: { command: options.command ?? unexpected },
    files: { write: unexpected },
    delete: unexpected,
    resume: unexpected,
    getStatus: unexpected,
  };
  return BoxExec.make.pipe(
    Effect.provideService(BoxExec.BoxExecThreadResolver, {
      resolve: options.resolve ?? (() => Effect.succeed(thread)),
    }),
    Effect.provideService(BoxApi.BoxApi, {
      get:
        options.get ??
        (async (id, apiKey) => {
          assert.equal(id, "persisted-box-id");
          assert.equal(apiKey, "private-key");
          return box;
        }),
      create: unexpected,
      list: unexpected,
      checkModelKey: unexpected,
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
          assert.equal(command, `cd -- '${expected}' || exit 1\nprintf '%s' 'a'\\''b; $(no)'`);
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
    for (const driver of [
      thread.providerThread.driver,
      ...Object.values(BOX_HARNESS_DRIVER_KINDS),
    ]) {
      const exec = yield* service({
        resolve: () =>
          Effect.succeed({
            ...thread,
            providerThread: {
              ...thread.providerThread,
              driver,
              nativeThreadRef: { ...thread.providerThread.nativeThreadRef!, driver },
            },
          }),
        command: async () => ({ exitCode: 0, stdout: "" }),
      });
      assert.deepEqual(yield* exec.run({ threadId, command: "true" }), {
        exitCode: 0,
        stdout: "",
        stderr: "",
      });
    }
  }),
);

it.effect("does not run any shell statements when the checkout directory is unavailable", () =>
  Effect.gen(function* () {
    const exec = yield* service({
      command: async (command) => {
        const result = NodeChildProcess.spawnSync("sh", ["-c", command], { encoding: "utf8" });
        if (result.error) throw result.error;
        return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr };
      },
    });
    for (const command of ["printf first; printf escaped", "printf first\nprintf escaped"]) {
      const result = yield* exec.run({ threadId, cwd: "/dev/null/not-a-directory", command });
      assert.equal(result.exitCode, 1);
      assert.equal(result.stdout, "");
    }
  }),
);

it.effect("fails closed without creating Boxes or exposing SDK errors", () =>
  Effect.gen(function* () {
    for (const [resolve, reason] of [
      [() => Effect.succeed(null), "thread_unavailable"],
      [
        () =>
          Effect.fail(
            Object.assign(new BoxExec.BoxExecError({ threadId, reason: "resolve_failed" }), {
              cause: Object.assign(new BoxError("private SDK failure"), {
                headers: { Authorization: "private SDK credential" },
                apiKey: "private SDK credential",
              }),
            }),
          ),
        "resolve_failed",
      ],
      [
        () => Effect.fail(new BoxExec.BoxExecError({ threadId, reason: "resolve_failed" })),
        "resolve_failed",
      ],
      [
        () => Effect.fail(new BoxExec.BoxExecError({ threadId, reason: "not_box_thread" })),
        "not_box_thread",
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
