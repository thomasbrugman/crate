import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import type { BoxHarness } from "../harnesses.ts";
import { BOX_HOME, BoxRuntimeError, type BoxHandle } from "./BoxApi.ts";

/** Where each harness keeps its session transcripts inside a Box. */
export const BOX_TRANSCRIPT_ROOTS = {
  commandCode: `${BOX_HOME}/.commandcode/projects`,
  claudeCode: `${BOX_HOME}/.claude/projects`,
  codex: `${BOX_HOME}/.codex/sessions`,
} as const satisfies Record<BoxHarness, string>;

const READ_CHUNK_BYTES = 1024 * 1024;

/** Host copies of Box transcripts, one subdirectory per Box, so usage outlives the Box. */
export const boxTranscriptMirrorDir = (path: Path.Path, stateDir: string, harness: BoxHarness) =>
  path.join(stateDir, "box-transcripts", harness);

const listCommand = (root: string) =>
  `test -d ${root} && find ${root} -type f -name '*.jsonl' ! -name '*.checkpoints.jsonl' -printf '%P\\t%s\\n' || true`;

const mirrorError = () => new BoxRuntimeError({ operation: "mirrorTranscripts" });

/**
 * Appends what each Box transcript gained since the last copy. Transcripts only grow, so a
 * copy longer than its source means the file was replaced and is copied again from the start.
 */
export const mirrorBoxTranscripts = Effect.fn("UpstashBox.mirrorBoxTranscripts")(function* (
  box: BoxHandle,
  harness: BoxHarness,
  mirrorDir: string,
) {
  const read = box.files.readBase64;
  if (!read) return;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = BOX_TRANSCRIPT_ROOTS[harness];
  const target = path.join(mirrorDir, path.basename(box.id));
  const { stdout } = yield* Effect.tryPromise({
    try: () => box.exec.command(listCommand(root)),
    catch: mirrorError,
  });
  for (const line of stdout.split("\n")) {
    const [relative, sizeText, ...rest] = line.split("\t");
    const size = Number(sizeText);
    if (!relative || rest.length > 0 || !Number.isSafeInteger(size) || size < 0) continue;
    const segments = relative.split("/");
    if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) continue;
    const destination = path.join(target, ...segments);
    const copied = yield* fileSystem.stat(destination).pipe(
      Effect.map((info) => Number(info.size)),
      Effect.orElseSucceed(() => 0),
    );
    if (copied === size) continue;
    let offset = copied < size ? copied : 0;
    yield* fileSystem.makeDirectory(path.dirname(destination), { recursive: true });
    if (offset === 0) yield* fileSystem.writeFile(destination, new Uint8Array());
    while (offset < size) {
      const length = Math.min(READ_CHUNK_BYTES, size - offset);
      const chunk = yield* Effect.tryPromise({
        try: () => read(`${root}/${relative}`, offset, length),
        catch: mirrorError,
      });
      const bytes = Buffer.from(chunk, "base64");
      if (bytes.length === 0) break;
      yield* fileSystem.writeFile(destination, bytes, { flag: "a" });
      offset += bytes.length;
    }
  }
});
