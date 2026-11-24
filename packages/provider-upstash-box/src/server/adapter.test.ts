// @effect-diagnostics nodeBuiltinImport:off - exercises cleanup against a disposable Git repository.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import {
  MessageId,
  ContextHandoffId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
  type ChatAttachment,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { knownProviderFailureMessage } from "@t3tools/provider-core/server/failure";
import {
  ProviderAdapterV2Event,
  type ProviderAdapterV2TurnInput,
} from "@t3tools/provider-core/server/ProviderAdapter";
import { BoxError, type BoxConfig, type Chunk } from "@upstash/box";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";

import { BOX_HARNESS_DRIVER_KINDS, type BoxHarness } from "../harnesses.ts";
import { makeUpstashBoxAdapter } from "./adapter.ts";
import {
  BOX_ATTACHMENTS_PATH,
  BoxApi,
  type BoxHandle,
  type BoxStream,
  type BoxSubagentChunk,
} from "./BoxApi.ts";
import { EXCLUDE_HARNESS_FILES_COMMAND } from "./git.ts";
import { commandCodeHarness } from "./harness.ts";

const instanceId = ProviderInstanceId.make("box-test");
const agentApiKey = "agent-credential-789";
const threadId = ThreadId.make("thread-box-test");
const modelSelection = { instanceId, model: "default" };
const runtimePolicy = {
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: null,
} as const;
const finish: Chunk = {
  type: "finish",
  output: "hello",
  usage: { inputTokens: 10, outputTokens: 2, cachedInputTokens: 4 },
  sessionId: "cc-session",
};

const setup = Effect.fn("test.setupBox")(function* (
  stream: BoxStream | (() => Promise<BoxStream>),
  deleteBox?: () => Promise<void>,
  harness: BoxHarness = "commandCode",
  command?: BoxHandle["exec"]["command"],
  apiKey = "test-key",
  githubToken?: string,
  attachmentFiles?: {
    readonly resolve: (attachment: ChatAttachment) => string | null;
    readonly upload: NonNullable<BoxHandle["files"]["upload"]>;
  },
) {
  const commands: string[] = [];
  const prompts: string[] = [];
  const harnesses: string[] = [];
  const lookup: {
    error?: unknown;
    createError?: unknown;
    exec?: BoxHandle["exec"]["command"];
    statusError?: unknown;
    streamError?: unknown;
    resumeError?: unknown;
    replacement?: BoxHandle;
    resumes: number;
    gitCredentialWrites: number;
  } = { resumes: 0, gitCredentialWrites: 0 };
  const createdSizes: BoxConfig["size"][] = [];
  const box: BoxHandle = {
    id: "box-123",
    agent: {
      stream: async ({ prompt }) => {
        prompts.push(prompt);
        if (lookup.error) throw lookup.error;
        if (lookup.streamError) throw lookup.streamError;
        return typeof stream === "function" ? await stream() : stream;
      },
    },
    exec: {
      command: async (text) => {
        commands.push(text);
        if (githubToken && lookup.resumes && text.startsWith("test -s /dev/shm/t3stash-git/"))
          return { stdout: "", exitCode: 1 };
        return lookup.exec
          ? lookup.exec(text)
          : command
            ? command(text)
            : { stdout: "", exitCode: 0 };
      },
    },
    files: {
      ...(attachmentFiles ? { upload: attachmentFiles.upload } : {}),
      write: async ({ content }) => {
        harnesses.push(content);
      },
      writeVolatile: async (path) => {
        if (path === "/dev/shm/t3stash-git/credential") lookup.gitCredentialWrites++;
      },
    },
    delete: deleteBox ?? (async () => undefined),
    resume: async () => {
      lookup.resumes++;
      if (lookup.resumeError) throw lookup.resumeError;
      lookup.streamError = undefined;
    },
    getStatus: async () => {
      if (lookup.statusError) throw lookup.statusError;
      return { status: "idle" };
    },
  };
  const adapter = yield* makeUpstashBoxAdapter(
    instanceId,
    { driver: BOX_HARNESS_DRIVER_KINDS[harness], harness, agentApiKey },
    Effect.succeed({
      apiKey,
      templateBoxName: "cc-harness",
      size: "small",
      ...(githubToken ? { githubToken } : {}),
    }),
    undefined,
    attachmentFiles?.resolve,
  ).pipe(
    Effect.provide(IdAllocator.layer),
    Effect.provideService(BoxApi, {
      get: async (id) => {
        if (lookup.error) throw lookup.error;
        if (id.startsWith("t3-") && lookup.statusError) throw lookup.statusError;
        return lookup.replacement ?? box;
      },
      create: async ({ size }) => {
        if (lookup.createError) throw lookup.createError;
        createdSizes.push(size);
        lookup.error = undefined;
        lookup.statusError = undefined;
        return lookup.replacement ?? box;
      },
      list: async () => [],
      checkModelKey: async () => 200,
    }),
  );
  const runtime = yield* adapter.openSession({
    threadId,
    providerSessionId: ProviderSessionId.make("box-session"),
    modelSelection,
    runtimePolicy,
  });
  const providerThread = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
  const now = yield* DateTime.now;
  const turn: ProviderAdapterV2TurnInput = {
    appThread: {
      id: threadId,
      projectId: ProjectId.make("box-project"),
      title: "Box",
      providerInstanceId: instanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: providerThread.id,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdBy: "user",
      creationSource: "web",
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
    threadId,
    runId: RunId.make("box-run"),
    runOrdinal: 1,
    providerTurnOrdinal: 1,
    attemptId: RunAttemptId.make("box-attempt"),
    rootNodeId: NodeId.make("box-root"),
    providerThread,
    message: {
      messageId: MessageId.make("box-user-message"),
      text: "hello",
      attachments: [],
      createdBy: "user",
      creationSource: "web",
    },
    modelSelection,
    runtimePolicy,
  };
  return { runtime, turn, prompts, adapter, lookup, box, commands, harnesses, createdSizes };
});

it.effect("explains missing and rejected API keys without exposing upstream details", () =>
  Effect.scoped(
    Effect.gen(function* () {
      for (const harness of ["commandCode", "claudeCode", "codex"] as const) {
        const { runtime, lookup, turn } = yield* setup(fakeStream([]), undefined, harness);
        for (const status of [401, 403, 500]) {
          lookup.error = new BoxError("private upstream body with test-key", status);
          const error = yield* runtime
            .ensureThread({ threadId, modelSelection, runtimePolicy })
            .pipe(Effect.flip);
          assert.equal(
            knownProviderFailureMessage(error),
            status === 500
              ? undefined
              : "Upstash Box rejected the API key. Check it in Settings → Providers.",
          );
          assert.notInclude(JSON.stringify(error), "private upstream body");
          assert.notInclude(JSON.stringify(error), "test-key");
        }
        const missing = yield* setup(fakeStream([]), undefined, harness, undefined, "").pipe(
          Effect.flip,
        );
        assert.equal(
          knownProviderFailureMessage(missing),
          "Upstash Box API key is missing. Add it in Settings → Providers.",
        );
        lookup.error = new BoxError("private upstream body with test-key", 401);
        const resumed = yield* runtime
          .resumeThread({ providerThread: turn.providerThread })
          .pipe(Effect.flip);
        assert.equal(
          knownProviderFailureMessage(resumed),
          "Upstash Box rejected the API key. Check it in Settings → Providers.",
        );
        lookup.error = new BoxError("missing", 404);
        lookup.createError = new BoxError("private upstream body with test-key", 401);
        const recreated = yield* runtime
          .resumeThread({ providerThread: turn.providerThread })
          .pipe(Effect.flip);
        assert.equal(
          knownProviderFailureMessage(recreated),
          "Upstash Box rejected the API key. Check it in Settings → Providers.",
        );
        assert.notInclude(JSON.stringify(recreated), "private upstream body");
        assert.notInclude(JSON.stringify(recreated), "test-key");
      }
    }),
  ),
);

it.effect("uses the saved Box size for provisioning and reprovisioning", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { runtime, turn, lookup, createdSizes } = yield* setup(fakeStream([]));
      lookup.error = new BoxError("Box not found", 404);
      yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
      lookup.error = new BoxError("Box not found", 404);
      yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy: { ...runtimePolicy, boxSize: "medium" },
      });
      lookup.error = new BoxError("Box not found", 404);
      yield* runtime.resumeThread({
        providerThread: turn.providerThread,
        runtimePolicy: { ...runtimePolicy, boxSize: "large" },
      });
      assert.deepEqual(createdSizes, ["small", "medium", "large"]);
    }),
  ),
);

it.live("releases idle Boxes only when all their checkouts contain no unsaved work", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const home = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "box-saved-work-"))),
        (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
      );
      const repo = NodePath.join(home, "repo");
      yield* Effect.promise(() => NodeFSP.mkdir(repo));
      // Upstash creates .box-internal with every browser Box and .box once an init command is set.
      for (const name of [".box", ".box-internal", ".claude", ".codex", ".cursor", ".local"]) {
        const path = NodePath.join(home, name);
        yield* Effect.promise(() => NodeFSP.mkdir(path));
        yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(path, "config.json"), "{}"));
      }
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(repo, ".gitignore"), ".env\n*.sqlite\n"),
      );
      const worktree = NodePath.join(home, ".t3stash-worktrees", "6368696c64");
      const git = (...args: string[]) =>
        NodeChildProcess.execFileSync("git", args, { cwd: repo, stdio: "pipe" });
      yield* Effect.sync(() => {
        git("init");
        git("add", ".gitignore");
        git(
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.invalid",
          "commit",
          "-m",
          "initial",
        );
        git("update-ref", "refs/remotes/origin/main", "HEAD");
        git("worktree", "add", "--detach", worktree, "HEAD");
      });
      let deleted = 0;
      const { adapter, turn } = yield* setup(
        fakeStream([]),
        async () => {
          deleted++;
        },
        "commandCode",
        async (command) => {
          if (!command.includes("clean_checkout")) return { stdout: "", exitCode: 0 };
          const result = NodeChildProcess.spawnSync(
            "sh",
            ["-c", command.replaceAll("/workspace/home", home)],
            { encoding: "utf8" },
          );
          return { stdout: result.stdout, exitCode: result.status ?? 1 };
        },
      );
      // Command Code writes taste learnings into whichever checkout it runs in.
      for (const checkout of [repo, worktree]) {
        for (const file of ["taste.md", "cli/taste.md"]) {
          const path = NodePath.join(checkout, ".commandcode", "taste", file);
          yield* Effect.promise(() => NodeFSP.mkdir(NodePath.dirname(path), { recursive: true }));
          yield* Effect.promise(() => NodeFSP.writeFile(path, "learned"));
        }
      }
      // Boxes set up before the exclude existed still count taste files as saved.
      assert.isTrue(yield* adapter.deleteIdleThread!(turn.providerThread));
      assert.equal(deleted, 1);
      const excludeHarnessFiles = () =>
        NodeChildProcess.execFileSync("sh", [
          "-c",
          EXCLUDE_HARNESS_FILES_COMMAND.replaceAll("/workspace/home", home),
        ]);
      yield* Effect.sync(() => {
        excludeHarnessFiles();
        excludeHarnessFiles();
      });
      assert.equal(
        yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(repo, ".git", "info", "exclude"), "utf8"),
        ).pipe(
          Effect.map(
            (exclude) =>
              exclude.split("\n").filter((line) => line === "/.commandcode/taste/").length,
          ),
        ),
        1,
      );
      for (const checkout of [repo, worktree]) {
        assert.equal(git("-C", checkout, "status", "--porcelain", "-uall").toString(), "");
        git("-C", checkout, "add", "-A");
        assert.equal(git("-C", checkout, "diff", "--cached", "--name-only").toString(), "");
      }
      assert.isTrue(yield* adapter.deleteIdleThread!(turn.providerThread));
      assert.equal(deleted, 2);
      const attachments = NodePath.join(home, ".t3stash-attachments");
      const attachmentTurn = NodePath.join(attachments, "7475726e");
      const attachment = NodePath.join(attachmentTurn, "0-notes.txt");
      yield* Effect.promise(() => NodeFSP.mkdir(attachmentTurn, { recursive: true }));
      yield* Effect.promise(() => NodeFSP.writeFile(attachment, "original"));
      yield* Effect.sync(() =>
        NodeChildProcess.execFileSync("sh", ["-c", "sha256sum ./0-notes.txt > .checksums"], {
          cwd: attachmentTurn,
        }),
      );
      assert.isTrue(yield* adapter.deleteIdleThread!(turn.providerThread));
      assert.equal(deleted, 3);
      yield* Effect.promise(() => NodeFSP.writeFile(attachment, "edited"));
      assert.isFalse(yield* adapter.deleteIdleThread!(turn.providerThread));
      assert.equal(deleted, 3);
      yield* Effect.promise(() => NodeFSP.rm(attachments, { recursive: true }));
      for (const checkout of [repo, worktree]) {
        for (const file of [".env", ".commandcode/notes.md"]) {
          const path = NodePath.join(checkout, file);
          yield* Effect.promise(() => NodeFSP.writeFile(path, "fixture"));
          assert.isFalse(yield* adapter.deleteIdleThread!(turn.providerThread));
          assert.equal(deleted, 3);
          yield* Effect.promise(() => NodeFSP.unlink(path));
        }
      }
      yield* Effect.sync(() =>
        git(
          "-C",
          worktree,
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.invalid",
          "commit",
          "--allow-empty",
          "-m",
          "unpushed child work",
        ),
      );
      assert.isFalse(yield* adapter.deleteIdleThread!(turn.providerThread));
      assert.equal(deleted, 3);
      yield* Effect.sync(() => git("worktree", "remove", "--force", worktree));
      yield* Effect.promise(() => NodeFSP.rm(repo, { recursive: true }));
      assert.isTrue(yield* adapter.deleteIdleThread!(turn.providerThread));
      yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(home, "notes.txt"), "fixture"));
      assert.isFalse(yield* adapter.deleteIdleThread!(turn.providerThread));
      assert.equal(deleted, 4);
    }),
  ),
);

it.effect("deletes native Boxes, keeps idle Boxes with unsaved work, and sanitizes failures", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let deleted = 0;
      let exitCode = 0;
      const { adapter, turn, lookup, commands } = yield* setup(
        fakeStream([]),
        async () => {
          deleted++;
        },
        "commandCode",
        async (command) => ({
          stdout: "",
          exitCode: command.includes("clean_checkout") ? exitCode : 0,
        }),
      );
      yield* adapter.deleteThread!(turn.providerThread);
      assert.equal(deleted, 1);
      lookup.error = new BoxError("private upstream body", 404);
      yield* adapter.deleteThread!(turn.providerThread);
      assert.equal(deleted, 1);
      lookup.error = new Error("private upstream body");
      const error = yield* adapter.deleteThread!(turn.providerThread).pipe(Effect.flip);
      assert.equal(error._tag, "ProviderAdapterProtocolError");
      assert.notInclude(JSON.stringify(error), "private upstream body");
      yield* adapter.deleteThread!({
        ...turn.providerThread,
        nativeThreadRef: null,
        appThreadId: null,
      });
      lookup.error = undefined;
      exitCode = 1;
      assert.isFalse(yield* adapter.deleteIdleThread!(turn.providerThread));
      assert.equal(deleted, 1);
      exitCode = 0;
      assert.isTrue(yield* adapter.deleteIdleThread!(turn.providerThread));
      assert.equal(deleted, 2);
      lookup.error = new BoxError("private upstream body", 404);
      assert.isTrue(yield* adapter.deleteIdleThread!(turn.providerThread));
      assert.lengthOf(
        commands.filter((text) => text.includes("clean_checkout")),
        2,
      );
    }),
  ),
);

function fakeStream(
  chunks: ReadonlyArray<Chunk | BoxSubagentChunk>,
  error: unknown = false,
): BoxStream {
  return {
    id: "native-run",
    cancel: async () => undefined,
    async *[Symbol.asyncIterator]() {
      yield* chunks;
      if (error) throw error === true ? new Error("private upstream error must not escape") : error;
    },
  };
}

it.effect("cancels a run that finishes starting while its session shuts down", () =>
  Effect.gen(function* () {
    const starting = Promise.withResolvers<void>();
    const ready = Promise.withResolvers<BoxStream>();
    let cancelled = 0;
    let cleaned = 0;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const { runtime, turn, lookup } = yield* setup(async () => {
          starting.resolve();
          return ready.promise;
        });
        lookup.exec = async () => {
          assert.isAbove(cancelled, 0);
          cleaned++;
          return { stdout: "", exitCode: 0 };
        };
        yield* runtime.events.pipe(
          Stream.takeUntil((event) => event.type === "provider_thread.updated"),
          Stream.runDrain,
        );
        yield* runtime.startTurn({
          ...turn,
          providerThread: { ...turn.providerThread, status: "active" },
        });
        yield* Effect.promise(() => starting.promise);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() =>
            ready.resolve({
              ...fakeStream([]),
              cancel: async () => {
                cancelled++;
              },
            }),
          ),
        );
        const startingEvents = yield* runtime.events.pipe(
          Stream.takeUntil(
            (event) => event.type === "node.updated" && event.node.status === "running",
          ),
          Stream.runCollect,
        );
        assert.isFalse(
          startingEvents.some(
            (event) =>
              event.type === "provider_thread.updated" && event.providerThread.status === "idle",
          ),
          "Starting a live turn must not make the thread ineligible for restart continuation",
        );
      }),
    );
    assert.equal(cancelled, 1);
    assert.isAbove(cleaned, 0);
  }),
);

const decodeEvent = Schema.decodeEffect(ProviderAdapterV2Event);
const collect = <E>(events: Stream.Stream<ProviderAdapterV2Event, E>) =>
  events.pipe(
    Stream.takeUntil((event) => event.type === "turn.terminal"),
    Stream.runCollect,
  );

it.effect("stages image and file attachments in the Box before starting the harness", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const uploaded: Array<{ path: string; destination: string }> = [];
      const { runtime, turn, prompts, commands } = yield* setup(
        async () => {
          assert.lengthOf(uploaded, 2);
          return fakeStream([finish]);
        },
        undefined,
        "commandCode",
        undefined,
        undefined,
        undefined,
        {
          resolve: (attachment) => `/server/attachments/${attachment.id}`,
          upload: async (files) => {
            uploaded.push(...files);
          },
        },
      );
      yield* runtime.startTurn({
        ...turn,
        appContext: [{ key: "handoff", text: "Earlier conversation" }],
        message: {
          ...turn.message,
          text: "/review focused changes",
          attachments: [
            {
              type: "image",
              id: "image-id",
              name: "diagram.png",
              mimeType: "image/png",
              sizeBytes: 20,
            },
            {
              type: "file",
              id: "file-id",
              name: "../notes.txt",
              mimeType: "text/plain",
              sizeBytes: 12,
            },
          ],
        },
      });
      yield* collect(runtime.events);
      const destination = `${BOX_ATTACHMENTS_PATH}/${Buffer.from(turn.attemptId).toString("hex")}`;
      assert.deepEqual(uploaded, [
        { path: "/server/attachments/image-id", destination: `${destination}/0-diagram.png` },
        { path: "/server/attachments/file-id", destination: `${destination}/1-.._notes.txt` },
      ]);
      assert.include(commands.join("\n"), `umask 077; mkdir -p -- '${destination}'`);
      assert.include(
        commands.join("\n"),
        `checksum_attachments '${destination}' > '${destination}/.checksums'`,
      );
      assert.include(prompts[0], uploaded[0]!.destination);
      assert.include(prompts[0], uploaded[1]!.destination);
      assert.match(prompts[0]!, /^t3stash-run:[a-f0-9]+\n\/review focused changes/u);
      assert.include(prompts[0], "Earlier conversation");
      assert.notInclude(prompts[0], "/server/attachments");
    }),
  ),
);

it.effect("projects native subagent results into separate linked conversations", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { runtime, turn } = yield* setup(
        fakeStream([
          { type: "subagent-start", taskId: "first", title: "Review", prompt: "Review the patch" },
          {
            type: "subagent-start",
            taskId: "nested",
            parentTaskId: "first",
            title: "Compare",
            prompt: "Compare approaches",
          },
          {
            type: "subagent-finish",
            taskId: "first",
            status: "completed",
            result: "Review result",
          },
          finish,
        ]),
        undefined,
        "claudeCode",
      );
      yield* runtime.startTurn(turn);
      const events = yield* Effect.forEach(yield* collect(runtime.events), (event) =>
        decodeEvent(event),
      );
      const [child, nested] = events.flatMap((event) =>
        event.type === "app_thread.created" ? [event.appThread] : [],
      );
      assert.equal(child?.lineage.parentThreadId, turn.threadId);
      assert.equal(nested?.lineage.parentThreadId, child?.id);
      assert.deepEqual(
        events.flatMap((event) =>
          event.type === "message.updated" && event.message.text === "Review result"
            ? [event.message.threadId]
            : [],
        ),
        [child?.id],
      );
      assert.isTrue(
        events.some(
          (event) =>
            event.type === "subagent.updated" &&
            event.subagent.childThreadId === nested?.id &&
            event.subagent.status === "interrupted",
        ),
      );
    }),
  ),
);

it.effect("shares a Box across harnesses and gives a linked subagent an isolated checkout", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const streams: string[] = [];
      const commands: string[] = [];
      const boxes = new Map<string, BoxHandle>();
      const api = BoxApi.of({
        get: async (name) => {
          const box = boxes.get(name);
          if (!box) throw new BoxError("missing", 404);
          return box;
        },
        create: async ({ name }) => {
          const box: BoxHandle = {
            id: name!,
            agent: {
              stream: async () => {
                throw new Error("unexpected native agent");
              },
            },
            exec: {
              command: async (command) => {
                commands.push(command);
                return { stdout: "", exitCode: 0 };
              },
              stream: async (command) => {
                streams.push(command);
                return {
                  id: "process",
                  cancel: async () => undefined,
                  async *[Symbol.asyncIterator]() {
                    yield {
                      type: "output",
                      data: 'event: done\ndata: {"session_id":"fixture-session"}\n\n',
                    } as const;
                    yield { type: "exit", exitCode: 0, cpuNs: 0 } as const;
                  },
                };
              },
            },
            files: { write: async () => undefined, writeVolatile: async () => undefined },
            getStatus: async () => ({ status: "idle" }),
            delete: async () => undefined,
            resume: async () => undefined,
          };
          boxes.set(box.id, box);
          return box;
        },
        list: async () => [],
        checkModelKey: async () => 200,
      });
      const policy = { ...runtimePolicy, repositoryUrl: "https://example.test/repo.git" };
      const environment = Effect.succeed({
        apiKey: "fixture-key",
        templateBoxName: "",
        size: "small" as const,
        credentials: { commandCode: '{"token":"fixture"}', codex: "fixture-key" },
      });
      const open = (harness: BoxHarness, owner: ThreadId, thread: ThreadId, worktree: boolean) =>
        Effect.gen(function* () {
          const providerId = ProviderInstanceId.make(harness);
          const selected = { ...modelSelection, instanceId: providerId };
          const turnPolicy = worktree ? { ...policy, boxOwnerThreadId: owner } : policy;
          const adapter = yield* makeUpstashBoxAdapter(
            providerId,
            { harness, driver: BOX_HARNESS_DRIVER_KINDS[harness], agentApiKey: "" },
            environment,
          ).pipe(Effect.provide(IdAllocator.layer), Effect.provideService(BoxApi, api));
          const session = yield* adapter.openSession({
            threadId: thread,
            providerSessionId: ProviderSessionId.make(`${harness}-${thread}`),
            modelSelection: selected,
            runtimePolicy: turnPolicy,
          });
          const loaded = yield* session.ensureThread({
            threadId: thread,
            modelSelection: selected,
            runtimePolicy: turnPolicy,
          });
          return { session, loaded, selected, turnPolicy };
        });
      const child = ThreadId.make("linked-child");
      const fork = ThreadId.make("manual-fork");
      const [main, switched] = yield* Effect.all(
        [open("commandCode", threadId, threadId, false), open("codex", threadId, threadId, false)],
        { concurrency: 2 },
      );
      const linked = yield* open("codex", threadId, child, true);
      const manual = yield* open("codex", fork, fork, false);
      assert.equal(boxes.size, 2);
      assert.equal(
        switched.loaded.nativeThreadRef?.nativeId,
        main.loaded.nativeThreadRef?.nativeId,
      );
      assert.equal(linked.loaded.nativeThreadRef?.nativeId, main.loaded.nativeThreadRef?.nativeId);
      assert.equal(linked.loaded.nativeMetadata?.boxOwnerThreadId, threadId);
      assert.isUndefined(manual.loaded.nativeMetadata?.boxOwnerThreadId);
      assert.notEqual(
        manual.loaded.nativeThreadRef?.nativeId,
        main.loaded.nativeThreadRef?.nativeId,
      );
      assert.notEqual(switched.loaded.id, main.loaded.id);
      assert.notEqual(linked.loaded.id, switched.loaded.id);
      const dispatchCommit = "1234567890abcdef1234567890abcdef12345678";
      const { turn } = yield* setup(fakeStream([]));
      for (const [thread, target] of [
        [threadId, switched],
        [child, linked],
      ] as const) {
        yield* target.session.startTurn({
          ...turn,
          threadId: thread,
          providerThread: target.loaded,
          modelSelection: target.selected,
          runtimePolicy: target.turnPolicy,
          appThread: {
            ...turn.appThread,
            lineage: {
              ...turn.appThread.lineage,
              ...(thread === child ? { boxBaseCommit: dispatchCommit } : {}),
            },
          },
          appContext: [{ key: "handoff", text: "Earlier conversation" }],
        });
        yield* collect(target.session.events);
      }
      assert.include(streams[0], "cd /workspace/home/repo");
      assert.include(streams[0], "Earlier conversation");
      const worktree = `/workspace/home/.t3stash-worktrees/${Buffer.from(child).toString("hex")}`;
      assert.include(streams[1], `cd ${worktree}`);
      assert.isTrue(
        commands.some((command) =>
          command.includes(`worktree add --detach -- ${worktree} '${dispatchCommit}'`),
        ),
      );
    }),
  ),
);

it.effect.each(["commandCode", "claudeCode", "codex"] as const)(
  "recreates a deleted Box before a follow-up even when the thread stays loaded (%s)",
  (harness) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { runtime, turn, lookup, box, createdSizes } = yield* setup(
          fakeStream([finish]),
          undefined,
          harness,
        );
        assert.equal(runtime.driver, BOX_HARNESS_DRIVER_KINDS[harness]);
        assert.isTrue(runtime.revalidateLoadedThreads);
        lookup.streamError = new BoxError("deleted", 404);
        yield* runtime.startTurn(turn);
        const failed = yield* collect(runtime.events);
        assert.equal(failed.at(-1)?.type, "turn.terminal");
        assert.equal(failed.find((e) => e.type === "turn.terminal")?.status, "failed");
        assert.isFalse(
          failed.some((e) => e.type === "turn_item.updated" && e.turnItem.type === "system_notice"),
        );
        lookup.streamError = undefined;
        lookup.statusError = new BoxError("deleted", 404);
        lookup.replacement = {
          ...box,
          id: "replacement-box",
          agent: { stream: async () => fakeStream([finish]) },
        };
        const replacement = yield* runtime.resumeThread({
          providerThread: turn.providerThread,
          threadId,
          modelSelection,
          runtimePolicy: { ...runtimePolicy, boxSize: "large" },
        });
        assert.deepEqual(createdSizes, ["large"]);
        assert.equal(replacement.nativeThreadRef?.nativeId, "replacement-box");
        yield* runtime.startTurn({ ...turn, providerThread: replacement });
        const recovered = yield* collect(runtime.events);
        assert.equal(runtime.providerSession.status, "ready");
        assert.equal(recovered.find((e) => e.type === "turn.terminal")?.status, "completed");
        const thread = recovered.find(
          (e) =>
            e.type === "provider_thread.updated" &&
            e.providerThread.nativeThreadRef?.nativeId === "replacement-box",
        );
        assert.isDefined(thread);
        if (thread?.type !== "provider_thread.updated") return;
        assert.equal(thread.providerThread.id, turn.providerThread.id);
        assert.isNull(thread.providerThread.nativeConversationHeadRef);
        assert.equal(lookup.resumes, 0);
        const notices = recovered.filter(
          (e) => e.type === "turn_item.updated" && e.turnItem.type === "system_notice",
        );
        assert.lengthOf(notices, 1);
        const notice = notices[0];
        if (notice?.type !== "turn_item.updated" || notice.turnItem.type !== "system_notice")
          return;
        assert.equal(notice.turnItem.level, "warning");
        assert.equal(
          notice.turnItem.message,
          "This thread's Box was gone, so a new one was started. The agent doesn't have the earlier conversation, and uncommitted changes from the old Box are lost.",
        );
        assert.equal(notice.turnItem.threadId, turn.threadId);
        assert.equal(notice.turnItem.runId, turn.runId);
        for (const event of recovered) yield* decodeEvent(event);
        yield* runtime.startTurn({ ...turn, providerThread: thread.providerThread });
        const next = yield* collect(runtime.events);
        assert.isFalse(
          next.some((e) => e.type === "turn_item.updated" && e.turnItem.type === "system_notice"),
        );
      }),
    ),
);

it.effect(
  "resumes a Box rejecting new runs after shutdown without replaying a started stream",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        using _githubUser = vi
          .spyOn(globalThis, "fetch")
          .mockImplementation(async () => Response.json({ id: 1, login: "fixture" }));
        for (const [status, resumeFails] of [
          [409, false],
          [401, false],
          [409, true],
        ] as const) {
          for (const harness of ["commandCode", "claudeCode", "codex"] as const) {
            const { adapter, turn, lookup } = yield* setup(
              fakeStream([finish]),
              undefined,
              harness,
              undefined,
              undefined,
              "fixture-github-token",
            );
            const runtime = yield* adapter.openSession({
              threadId,
              providerSessionId: ProviderSessionId.make("restarted-session"),
              modelSelection,
              runtimePolicy,
            });
            yield* runtime.resumeThread({ providerThread: turn.providerThread });
            lookup.streamError = new BoxError("private upstream error", status);
            if (resumeFails) lookup.resumeError = new Error("private upstream error");
            yield* runtime.startTurn(turn);
            const events = yield* collect(runtime.events);
            assert.equal(
              events.find((e) => e.type === "turn.terminal")?.status,
              status === 409 && !resumeFails ? "completed" : "failed",
            );
            assert.equal(lookup.resumes, status === 409 ? 1 : 0);
            assert.equal(lookup.gitCredentialWrites, status === 409 && !resumeFails ? 1 : 0);
            assert.notInclude(JSON.stringify(events), "private upstream error");
          }
        }
      }),
    ),
);

it.effect("publishes setup status and clears it on success or failure", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { runtime, lookup } = yield* setup(fakeStream([]));
      assert.equal(runtime.providerSession.status, "ready");
      lookup.error = new Error("private bootstrap failure");
      yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy }).pipe(Effect.flip);
      assert.equal(runtime.providerSession.status, "error");
      const events = yield* runtime.events.pipe(
        Stream.takeUntil(
          (event) =>
            event.type === "provider_session.updated" && event.providerSession.status === "error",
        ),
        Stream.runCollect,
      );
      assert.deepEqual(
        events
          .filter((event) => event.type === "provider_session.updated")
          .map((event) => [
            event.providerSession.status,
            event.providerSession.extensionStatuses?.map((status) => status.text).join(),
          ]),
        [
          ["starting", ""],
          ["starting", "Connecting to the Box"],
          ["starting", "Checking the Box setup,Connecting to the Box"],
          ["ready", ""],
          ["starting", ""],
          ["starting", "Connecting to the Box"],
          ["error", ""],
        ],
      );
      assert.notInclude(JSON.stringify(events), "private bootstrap failure");
    }),
  ),
);

it.effect(
  "translates a fake stream into accumulated text, paired tools, continuation identity and usage",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { runtime, turn, prompts, harnesses, commands } = yield* setup(
          fakeStream([
            { type: "start", runId: "native-run" },
            { type: "tool-result", output: "orphan" },
            { type: "tool-call", toolCallId: "read", toolName: "Read", input: { path: "first" } },
            {
              type: "tool-call",
              toolCallId: "write",
              toolName: "Write",
              input: { path: "second" },
            },
            { type: "tool-result", output: "ambiguous" },
            { type: "tool-result", toolCallId: "unknown", output: "orphan" },
            {
              type: "tool-result",
              toolCallId: "write",
              output: [{ type: "text", text: "wrote second" }],
            },
            { type: "tool-result", toolCallId: "read", output: "read first" },
            { type: "text-delta", text: "hel" },
            { type: "text-delta", text: "lo" },
            finish,
            { type: "stats", cpuNs: 1, memoryPeakBytes: 1 },
          ]),
        );
        const text = "Earlier context\n\nhello";
        commands.length = 0;
        yield* runtime.resumeThread({ providerThread: turn.providerThread });
        assert.include(commands, EXCLUDE_HARNESS_FILES_COMMAND);
        assert.deepEqual(harnesses, [commandCodeHarness, commandCodeHarness]);
        yield* runtime.startTurn({
          ...turn,
          providerThread: {
            ...turn.providerThread,
            id: ProviderThreadId.make("persisted-placeholder"),
          },
          message: { ...turn.message, text },
          inlineContextLength: text.length - 5,
        });
        const events = yield* collect(runtime.events);
        assert.deepEqual(prompts, [
          `t3stash-run:${Buffer.from(turn.attemptId).toString("hex")}\n${text}`,
        ]);
        for (const event of events) yield* decodeEvent(event);
        const messages = events
          .filter((event) => event.type === "message.updated")
          .map((event) => event.message);
        assert.deepEqual(
          messages.map((message) => [message.text, message.streaming]),
          [
            ["hel", true],
            ["hello", true],
            ["hello", false],
          ],
        );
        assert.isTrue(messages.every((message) => message.id === messages[0]?.id));
        const assistantItems = events.flatMap((event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "assistant_message"
            ? [event.turnItem]
            : [],
        );
        assert.deepEqual(
          assistantItems.map((item) => [item.text, item.streaming, item.messageId]),
          messages.map((message) => [message.text, message.streaming, message.id]),
        );
        assert.isTrue(assistantItems.every((item) => item.id === assistantItems[0]?.id));
        const completedTools = events
          .filter((event) => event.type === "turn_item.updated")
          .filter(
            (event) =>
              event.turnItem.type === "dynamic_tool" && event.turnItem.status === "completed",
          );
        assert.deepEqual(
          completedTools.map((event) => event.turnItem.title),
          ["Write", "Read"],
        );
        assert.deepEqual(
          completedTools.map((event) =>
            event.turnItem.type === "dynamic_tool" ? event.turnItem.output : null,
          ),
          [[{ type: "text", text: "wrote second" }], "read first"],
        );
        const turns = events.filter((event) => event.type === "provider_turn.updated");
        assert.deepEqual(turns.at(-1)?.providerTurn.tokenUsage, {
          inputTokens: 10,
          outputTokens: 2,
          cachedInputTokens: 4,
          usedTokens: 12,
          updatedAt: DateTime.formatIso(yield* DateTime.now),
        });
        const thread = events
          .filter((event) => event.type === "provider_thread.updated")
          .at(-1)?.providerThread;
        assert.equal(thread?.nativeThreadRef?.nativeId, "box-123");
        assert.equal(thread?.nativeConversationHeadRef?.nativeId, "cc-session");
        assert.equal(events.at(-1)?.type, "turn.terminal");
        assert.equal(
          events.filter((event) => event.type === "turn.terminal")[0]?.status,
          "completed",
        );
        const current = {
          ...turn.providerThread,
          firstRunOrdinal: 1,
          lastRunOrdinal: 2,
          handoffIds: [ContextHandoffId.make("follow-up-handoff")],
        };
        const attemptId = RunAttemptId.make("follow-up-attempt");
        yield* runtime.startTurn({
          ...turn,
          attemptId,
          providerThread: current,
          providerTurnOrdinal: 2,
        });
        const followUp = yield* collect(runtime.events);
        const saved = followUp
          .filter((event) => event.type === "provider_thread.updated")
          .at(-1)?.providerThread;
        assert.equal(saved?.firstRunOrdinal, current.firstRunOrdinal);
        assert.equal(saved?.lastRunOrdinal, current.lastRunOrdinal);
        assert.deepEqual(saved?.handoffIds, current.handoffIds);
        assert.equal(saved?.nativeConversationHeadRef?.nativeId, "cc-session");
        assert.equal(prompts[1], `t3stash-run:${Buffer.from(attemptId).toString("hex")}\nhello`);
      }),
    ),
);

it.effect("splits assistant messages around tools without duplicating finish output", () =>
  Effect.scoped(
    Effect.gen(function* () {
      for (const fail of [false, true]) {
        const { runtime, turn } = yield* setup(
          fakeStream(
            [
              { type: "text-delta", text: "editing." },
              { type: "tool-call", toolName: "Write", input: {} },
              { type: "tool-result", output: "done" },
              { type: "tool-call", toolName: "Read", input: {} },
              { type: "tool-result", output: "done" },
              { type: "text-delta", text: "Default " },
              { type: "text-delta", text: "verify." },
              { type: "tool-call", toolName: "Check", input: {} },
              { type: "tool-result", output: "done" },
              ...(fail ? [] : [{ ...finish, output: "editing.Default verify." }]),
            ],
            fail,
          ),
        );
        yield* runtime.startTurn(turn);
        const events = yield* collect(runtime.events);
        for (const event of events) yield* decodeEvent(event);
        const messages = events.flatMap((event) =>
          event.type === "message.updated" && !event.message.streaming ? [event.message] : [],
        );
        assert.deepEqual(
          messages.map((message) => message.text),
          ["editing.", "Default verify."],
        );
        assert.equal(new Set(messages.map((message) => message.id)).size, 2);
        const items = events.flatMap((event) =>
          event.type === "turn_item.updated" && event.turnItem.status === "completed"
            ? [event.turnItem]
            : [],
        );
        assert.deepEqual(
          items.map((item) => [item.type, item.ordinal]),
          [
            ["assistant_message", 1],
            ["dynamic_tool", 2],
            ["dynamic_tool", 3],
            ["assistant_message", 4],
            ["dynamic_tool", 5],
          ],
        );
        assert.equal(new Set(items.map((item) => item.id)).size, 5);
        assert.deepEqual(
          items.flatMap((item) => (item.type === "assistant_message" ? [item.messageId] : [])),
          messages.map((message) => message.id),
        );
      }
    }),
  ),
);

it.effect.each(["commandCode", "claudeCode", "codex"] as const)(
  "accepts an empty answer and distinguishes failed streams without leaking upstream errors (%s)",
  (harness) =>
    Effect.scoped(
      Effect.gen(function* () {
        const connection =
          "The connection to the Box ended before the agent finished. Send a message to retry.";
        const gone = "This thread's Box stopped mid-turn. Send a message to start a new one.";
        for (const [stream, status, message, statusError] of [
          [fakeStream([{ ...finish, output: "" }]), "completed", undefined, undefined],
          [fakeStream([]), "failed", connection, undefined],
          [
            fakeStream([{ type: "text-delta", text: "partial" }], true),
            "failed",
            connection,
            undefined,
          ],
          [
            fakeStream([], new BoxError("harness exited")),
            "failed",
            "The Box agent reported an error. Send a message to retry.",
            undefined,
          ],
          [
            fakeStream(
              [],
              Object.assign(new BoxError("harness exited"), {
                request: { headers: { Authorization: "private upstream credential" } },
                apiKey: "private upstream credential",
              }),
            ),
            "failed",
            connection,
            undefined,
          ],
          [
            fakeStream(
              [],
              new BoxError(
                JSON.stringify({
                  headers: { Authorization: "private upstream credential" },
                  apiKey: "private upstream credential",
                }),
              ),
            ),
            "failed",
            connection,
            undefined,
          ],
          [
            fakeStream([], new BoxError("")),
            "failed",
            "The Box agent reported an error. Send a message to retry.",
            undefined,
          ],
          [fakeStream([], new BoxError("private upstream body", 404)), "failed", gone, undefined],
          [
            async () => {
              throw new BoxError("private upstream body", 404);
            },
            "failed",
            gone,
            undefined,
          ],
          [
            async () => {
              throw new BoxError("private upstream body", 503);
            },
            "failed",
            connection,
            undefined,
          ],
          [
            async () => {
              throw new BoxError("private upstream body");
            },
            "failed",
            connection,
            undefined,
          ],
          [
            fakeStream([], new BoxError("private upstream body", 403)),
            "failed",
            connection,
            undefined,
          ],
          [
            fakeStream(
              [],
              new BoxError("Stream timed out", undefined, {
                cause: new Error("private upstream cause"),
              }),
            ),
            "failed",
            connection,
            undefined,
          ],
          [fakeStream([], true), "failed", gone, new BoxError("private upstream body", 404)],
          [fakeStream([]), "failed", gone, new BoxError("private upstream body", 404)],
          [
            fakeStream([], true),
            "failed",
            connection,
            new Error("private upstream status failure"),
          ],
        ] as const) {
          const { runtime, turn, lookup } = yield* setup(stream, undefined, harness);
          lookup.statusError = statusError;
          yield* runtime.startTurn(turn);
          const events = yield* collect(runtime.events);
          for (const event of events) yield* decodeEvent(event);
          const terminals = events.filter((event) => event.type === "turn.terminal");
          assert.lengthOf(terminals, 1);
          assert.equal(terminals[0]?.status, status);
          assert.equal(terminals[0]?.failure?.message, message);
          assert.notInclude(JSON.stringify(events), "private upstream");
          assert.equal(lookup.resumes, 0);
          if (status === "failed")
            assert.isFalse(
              events.filter((event) => event.type === "message.updated").at(-1)?.message
                .streaming ?? false,
            );
        }
      }),
    ),
);

it.effect.each(["commandCode", "claudeCode", "codex"] as const)(
  "does not expose the agent's error payload (%s)",
  (harness) =>
    Effect.scoped(
      Effect.gen(function* () {
        const secret = "opaque_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
        const { runtime, turn } = yield* setup(
          fakeStream(
            [],
            new BoxError(
              `harness failed: test-key ${agentApiKey} api_key=labelled-secret Bearer bearer-secret sk-abcdefghijklmnop ${secret} https://user:pass@example.test/path?token=url-secret\u001b[31m ${"detail ".repeat(80)}`,
            ),
          ),
          undefined,
          harness,
        );
        yield* runtime.startTurn(turn);
        const events = yield* collect(runtime.events);
        const terminal = events.find((event) => event.type === "turn.terminal");
        assert.equal(terminal?.status, "failed");
        const message = terminal?.failure?.message ?? "";
        assert.equal(message, "The Box agent reported an error. Send a message to retry.");
        for (const value of [
          "test-key",
          agentApiKey,
          "labelled-secret",
          "bearer-secret",
          "sk-abcdefghijklmnop",
          secret,
          "user:pass",
          "url-secret",
          "\u001b",
        ])
          assert.notInclude(JSON.stringify(events), value);
      }),
    ),
);

it.effect.each(["ok", "throw", "exit", "hang"] as const)(
  "cancels the active stream and interrupts despite %s cleanup",
  (cleanup) =>
    Effect.scoped(
      Effect.gen(function* () {
        const cancelled = Promise.withResolvers<void>();
        const releaseCleanup = Promise.withResolvers<{ stdout: string; exitCode: number }>();
        let cancelCount = 0;
        const order: string[] = [];
        const { runtime, turn, lookup } = yield* setup({
          id: "native-run",
          cancel: async () => {
            cancelCount++;
            order.push("cancel");
            cancelled.resolve();
          },
          async *[Symbol.asyncIterator]() {
            yield { type: "start", runId: "native-run" };
            await cancelled.promise;
          },
        });
        lookup.exec = async (command) => {
          assert.include(command, "t3stash-harness.mjs");
          order.push("kill");
          if (cleanup === "throw") throw new Error("private cleanup failure");
          if (cleanup === "hang") return releaseCleanup.promise;
          return { stdout: "", exitCode: cleanup === "exit" ? 1 : 0 };
        };
        yield* runtime.startTurn(turn);
        const started = yield* runtime.events.pipe(
          Stream.filter(
            (event) =>
              event.type === "provider_turn.updated" && event.providerTurn.nativeTurnRef !== null,
          ),
          Stream.take(1),
          Stream.runCollect,
        );
        const event = started[0];
        assert.isDefined(event);
        if (event?.type !== "provider_turn.updated")
          return yield* Effect.die("Missing start event");
        const interrupt = yield* runtime
          .interruptTurn({
            providerThread: turn.providerThread,
            providerTurnId: event.providerTurn.id,
          })
          .pipe(Effect.forkChild);
        if (cleanup === "hang") {
          yield* TestClock.adjust("8 seconds");
          const finished = interrupt.pollUnsafe();
          releaseCleanup.resolve({ stdout: "", exitCode: 0 });
          assert.isDefined(finished);
        }
        yield* Fiber.join(interrupt);
        const events = yield* collect(runtime.events);
        assert.equal(cancelCount, 1);
        assert.deepEqual(order, ["cancel", "kill"]);
        assert.equal(
          events.filter((entry) => entry.type === "turn.terminal")[0]?.status,
          "interrupted",
        );
      }),
    ),
);
