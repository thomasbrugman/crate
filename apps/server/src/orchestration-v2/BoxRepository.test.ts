import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { resolveBoxRepository } from "./BoxRepository.ts";

it.effect("resolves safe remote URLs from checkouts, worktree pointers and URL labels", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "box-repository-" });
    yield* fs.makeDirectory(path.join(root, ".git"));
    yield* fs.writeFileString(
      path.join(root, ".git", "config"),
      '[remote "backup"]\n url = https://example.com/backup.git\n[remote "origin"]\n url = git@github.com:owner/repo.git\n',
    );
    assert.equal(yield* resolveBoxRepository(root), "https://github.com/owner/repo.git");
    yield* fs.makeDirectory(path.join(root, "worktree"));
    yield* fs.makeDirectory(path.join(root, ".git", "worktrees", "one"), { recursive: true });
    yield* fs.writeFileString(
      path.join(root, "worktree", ".git"),
      "gitdir: ../.git/worktrees/one\n",
    );
    yield* fs.writeFileString(path.join(root, ".git", "worktrees", "one", "commondir"), "../..\n");
    assert.equal(
      yield* resolveBoxRepository(path.join(root, "worktree")),
      "https://github.com/owner/repo.git",
    );
    assert.equal(
      yield* resolveBoxRepository("https://user:private@example.com/repo.git"),
      "https://example.com/repo.git",
    );
    assert.equal(
      yield* resolveBoxRepository("ssh://git@github.com/owner/repo.git"),
      "https://github.com/owner/repo.git",
    );
    yield* fs.writeFileString(
      path.join(root, ".git", "config"),
      '[remote "backup"]\n url = https://example.com/backup.git\n',
    );
    assert.equal(yield* resolveBoxRepository(root), "https://example.com/backup.git");
    yield* fs.writeFileString(path.join(root, ".git", "config"), "[core]\n bare = false\n");
    assert.isUndefined(yield* resolveBoxRepository(root));
    assert.isUndefined(yield* resolveBoxRepository(path.join(root, "missing")));
    assert.isUndefined(yield* resolveBoxRepository("file:///private/repo"));
    yield* fs.writeFileString(path.join(root, "worktree", ".git"), "invalid pointer");
    assert.isUndefined(yield* resolveBoxRepository(path.join(root, "worktree")));
  }).pipe(Effect.provide(NodeServices.layer)),
);
