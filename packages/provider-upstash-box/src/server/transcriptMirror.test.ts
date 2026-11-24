import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import type { BoxHandle } from "./BoxApi.ts";
import { BOX_TRANSCRIPT_ROOTS, mirrorBoxTranscripts } from "./transcriptMirror.ts";

const root = BOX_TRANSCRIPT_ROOTS.commandCode;

function fakeBox(files: Map<string, string>) {
  const reads: Array<{ path: string; offset: number }> = [];
  const box = {
    id: "box-1",
    agent: { stream: async () => Promise.reject(new Error("unused")) },
    exec: {
      command: async () => ({
        exitCode: 0,
        stdout: [...files]
          .map(([path, content]) => `${path}\t${Buffer.byteLength(content)}\n`)
          .join(""),
      }),
    },
    files: {
      readBase64: async (path: string, offset: number, length: number) => {
        reads.push({ path, offset });
        const content = Buffer.from(files.get(path.slice(root.length + 1)) ?? "");
        return content.subarray(offset, offset + length).toString("base64");
      },
      write: async () => undefined,
    },
  } as unknown as BoxHandle;
  return { box, reads };
}

it.effect("copies new transcript bytes and recopies replaced files", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const mirrorDir = yield* fileSystem.makeTempDirectoryScoped();
    const copy = (name: string) =>
      fileSystem.readFileString(path.join(mirrorDir, "box-1", "workspace-home", name));
    const files = new Map([
      ["workspace-home/a.jsonl", '{"type":"session"}\n'],
      ["../escape.jsonl", "nope\n"],
      ["workspace-home\\..\\win-escape.jsonl", "nope\n"],
    ]);
    const { box, reads } = fakeBox(files);

    yield* mirrorBoxTranscripts(box, "commandCode", mirrorDir);
    assert.strictEqual(yield* copy("a.jsonl"), '{"type":"session"}\n');
    assert.isFalse(yield* fileSystem.exists(path.join(mirrorDir, "escape.jsonl")));
    assert.isFalse(yield* fileSystem.exists(path.join(mirrorDir, "win-escape.jsonl")));

    files.set("workspace-home/a.jsonl", '{"type":"session"}\n{"usage":{}}\n');
    reads.length = 0;
    yield* mirrorBoxTranscripts(box, "commandCode", mirrorDir);
    assert.strictEqual(yield* copy("a.jsonl"), '{"type":"session"}\n{"usage":{}}\n');
    assert.deepStrictEqual(reads, [{ path: `${root}/workspace-home/a.jsonl`, offset: 19 }]);

    files.set("workspace-home/a.jsonl", "{}\n");
    yield* mirrorBoxTranscripts(box, "commandCode", mirrorDir);
    assert.strictEqual(yield* copy("a.jsonl"), "{}\n");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
