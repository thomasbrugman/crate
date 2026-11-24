import {
  BOX_REPOSITORY_PATH,
  BOX_WORKSPACE_PATH,
  quoteShell,
  requireCommand,
  type BoxHandle,
} from "./BoxApi.ts";

export async function forkWorkspace(source: BoxHandle, target: BoxHandle, checkpointRef: string) {
  const read = source.files.readBase64;
  if (
    source.id === target.id ||
    read === undefined ||
    !checkpointRef.startsWith("refs/t3/orchestration-v2/checkpoints/")
  )
    throw new Error("Cannot copy the fork workspace.");
  const prefix = `${BOX_WORKSPACE_PATH}/.t3stash-fork-`;
  const created = await source.exec.command(`umask 077 && mktemp -d ${prefix}XXXXXXXXXX`);
  const scratch = created.stdout.trim();
  if (
    created.exitCode !== 0 ||
    !scratch.startsWith(prefix) ||
    !/^[A-Za-z0-9]{10}$/u.test(scratch.slice(prefix.length))
  )
    throw new Error("Could not prepare the fork checkpoint.");
  const bundle = `${scratch}/workspace.bundle`;
  const chunk = `${scratch}/chunk`;
  const git = `git -C ${BOX_REPOSITORY_PATH}`;
  const ref = quoteShell(checkpointRef);
  try {
    const exported = await source.exec.command(
      `umask 077 && ${git} bundle create ${bundle} ${ref} && stat -c %s -- ${bundle}`,
    );
    const size = Number(exported.stdout.trim());
    if (exported.exitCode !== 0 || !Number.isSafeInteger(size) || size <= 0)
      throw new Error("Could not export the fork checkpoint.");
    await requireCommand(target, `umask 077 && mkdir -- ${scratch} && touch ${bundle}`);
    const blockSize = 512 * 1024;
    for (let offset = 0; offset < size; offset += blockSize) {
      const length = Math.min(blockSize, size - offset);
      const content = await read(bundle, offset, length);
      if (Buffer.byteLength(content, "base64") !== length)
        throw new Error("The fork checkpoint transfer was incomplete.");
      await target.files.write({ path: chunk, content, encoding: "base64" });
      await requireCommand(target, `cat -- ${chunk} >> ${bundle} && rm -- ${chunk}`);
    }
    await requireCommand(
      target,
      `${git} fetch --no-tags -- ${bundle} ${ref} && ${git} checkout --detach FETCH_HEAD^ && ${git} restore --source=FETCH_HEAD --staged --worktree -- . && ${git} reset --quiet -- .`,
    );
  } finally {
    await Promise.allSettled(
      [source, target].map((box) => requireCommand(box, `rm -rf -- ${scratch}`)),
    );
  }
}
