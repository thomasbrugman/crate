import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

function repositoryUrl(value: string): string | undefined {
  const input = value.trim().replace(/^git@([^:]+):(.+)$/, "https://$1/$2");
  try {
    let url = new URL(input);
    if (url.protocol === "ssh:" && url.username === "git") {
      url = new URL(`https://${url.hostname}${url.pathname}`);
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    url.username = "";
    url.password = "";
    return url.href;
  } catch {
    return undefined;
  }
}

export const resolveBoxRepository = Effect.fn("BoxRepository.resolve")((label: string) =>
  Effect.gen(function* () {
    const direct = repositoryUrl(label);
    if (direct) return direct;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    let gitDir = path.resolve(label, ".git");
    const info = yield* fs.stat(gitDir);
    if (info.type !== "Directory") {
      const pointer = yield* fs.readFileString(gitDir);
      if (!pointer.startsWith("gitdir:")) return undefined;
      gitDir = path.resolve(label, pointer.slice(7).trim());
    }
    const commonDir = yield* fs
      .readFileString(path.resolve(gitDir, "commondir"))
      .pipe(Effect.orElseSucceed(() => undefined));
    if (commonDir !== undefined) gitDir = path.resolve(gitDir, commonDir.trim());
    const config = yield* fs.readFileString(path.resolve(gitDir, "config"));
    const remotes = [...config.matchAll(/^\[remote\s+"([^"]+)"\]\s*\n([^[]*)/gm)];
    const remote = remotes.find((match) => match[1] === "origin") ?? remotes[0];
    const value = remote?.[2]?.match(/^\s*url\s*=\s*(.+)$/m)?.[1]?.trim();
    return value ? repositoryUrl(value.replace(/^"(.*)"$/, "$1")) : undefined;
  }).pipe(
    Effect.provide(NodeServices.layer),
    Effect.orElseSucceed(() => undefined),
  ),
);
