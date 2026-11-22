// @effect-diagnostics-next-line nodeBuiltinImport:off - Box bootstrap uses promises.
import * as NodeCrypto from "node:crypto";
import { BOX_HOME, quoteShell, requireCommand, type BoxHandle } from "./BoxApi.ts";

const gitDir = "/dev/shm/t3stash-git";
const gitConfig = `${gitDir}/config`;
const gitCredential = `${gitDir}/credential`;
const gitStamp = `${gitDir}/stamp`;

async function gitHubIdentity(token: string) {
  // @effect-diagnostics-next-line globalFetch:off - Box bootstrap uses promises.
  const response = await fetch("https://api.github.com/user", {
    headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}` },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error("Could not read the GitHub account for Box Git setup.");
  const user: unknown = await response.json();
  if (
    typeof user !== "object" ||
    user === null ||
    !("login" in user) ||
    typeof user.login !== "string" ||
    !user.login.trim() ||
    !("id" in user) ||
    typeof user.id !== "number" ||
    !Number.isSafeInteger(user.id)
  ) {
    throw new Error("GitHub did not return a Git identity.");
  }
  return {
    name:
      "name" in user && typeof user.name === "string" && user.name.trim()
        ? user.name.trim()
        : user.login,
    email:
      "email" in user && typeof user.email === "string" && user.email.trim()
        ? user.email.trim()
        : `${user.id}+${user.login}@users.noreply.github.com`,
  };
}

export async function configureBoxGit(box: BoxHandle, rawToken: string | undefined) {
  const token = rawToken?.trim() ?? "";
  const legacyCredential = `${BOX_HOME}/.git-credentials`;
  if (!token) {
    await requireCommand(
      box,
      `rm -f -- ${legacyCredential} ${gitCredential} ${gitConfig} ${gitStamp}`,
    );
    return;
  }
  await requireCommand(box, `rm -f -- ${legacyCredential}`);
  const writeVolatile = box.files.writeVolatile;
  if (!writeVolatile || /\s/u.test(token)) throw new Error("Box Git credentials are unavailable.");

  const digest = NodeCrypto.createHash("sha256").update(token).digest("hex");
  const global = `GIT_CONFIG_GLOBAL=${BOX_HOME}/.gitconfig git config --global`;
  const include = `${global} --get-all include.path | grep -Fxq -- ${gitConfig}`;
  const ready = await box.exec.command(
    `test -s ${gitCredential} && test -s ${gitConfig} && test -f ${gitStamp} && test "$(cat ${gitStamp})" = ${digest} && { ${include}; }`,
  );
  if (ready.exitCode === 0) return;

  await requireCommand(
    box,
    `umask 077 && mkdir -p ${gitDir} && test "$(stat -f -c %T ${gitDir})" = tmpfs && rm -f -- ${gitCredential} ${gitConfig} ${gitStamp}`,
  );
  const { name, email } = await gitHubIdentity(token);
  const config = `GIT_CONFIG_GLOBAL=${gitConfig} git config --global`;
  const key = "credential.https://github.com.helper";
  const helper = `!f() { if test "$1" = get && test -r ${gitCredential}; then cat ${gitCredential}; fi; }; f`;
  await requireCommand(
    box,
    [
      "umask 077",
      `${config} -- user.name ${quoteShell(name)}`,
      `${config} -- user.email ${quoteShell(email)}`,
      `${config} --add ${key} ''`,
      `${config} --add ${key} ${quoteShell(helper)}`,
      `{ ${include} || ${global} --add include.path ${gitConfig}; }`,
    ].join(" && "),
  );
  await writeVolatile(gitCredential, `username=x-access-token\npassword=${token}\n`);
  await writeVolatile(gitStamp, digest);
}
