import { BoxError, type BoxConfig } from "@upstash/box";
// @effect-diagnostics-next-line nodeBuiltinImport:off - The SDK setup boundary uses promises.
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { isWorkerBoxHarness, type BoxHarness, type WorkerBoxHarness } from "../harnesses.ts";
import {
  BOX_HOME,
  BoxApi,
  BoxRuntimeError,
  boxConfig,
  isMissingBox,
  isMissingStoredKey,
  quoteShell,
  requireCommand,
  type BoxHandle,
} from "./BoxApi.ts";
import { installDevServerKeeper } from "./BoxServers.ts";
import { commandCodeHarness } from "./harness.ts";
import { managedHarness } from "./managedHarness.ts";
import {
  BOX_CREDENTIALS_DIR,
  BOX_COMMAND_CODE_HOME,
  harnessCredentialKind,
  type BoxHarnessCredentials,
} from "./credentials.ts";
import { EXCLUDE_HARNESS_FILES_COMMAND, makeBoxGitSetup } from "./git.ts";

const isBoxRuntimeError = Schema.is(BoxRuntimeError);

function isStaleSnapshot(error: unknown): boolean {
  return (
    error instanceof BoxError &&
    (error.statusCode === 404 ||
      ([400, 409, 410, 422].includes(error.statusCode ?? 0) &&
        /snapshot/i.test(error.message) &&
        /not found|missing|deleted|not ready|not in.*ready/i.test(error.message)))
  );
}

/** The thread's Box environment plus the agent that runs inside it. */
export interface BoxRuntimeConfig {
  readonly apiKey: string;
  readonly templateBoxName: string;
  readonly size: NonNullable<BoxConfig["size"]>;
  readonly harness: BoxHarness;
  readonly model: string;
  readonly agentApiKey: string;
  readonly credentials?: BoxHarnessCredentials;
  readonly githubToken?: string;
  readonly snapshotId?: string;
  readonly workerArtifact?: () => Promise<string>;
}

const BOOTSTRAPPED_MARKER = "/home/boxuser/.crate-bootstrapped";
const pendingSetups = new Map<string, Promise<BoxHandle>>();

function shareSetup(key: string, setup: () => Promise<BoxHandle>): Promise<BoxHandle> {
  const pending = pendingSetups.get(key);
  if (pending) return pending;
  const promise = setup()
    .then(async (box) => {
      await requireCommand(box, EXCLUDE_HARNESS_FILES_COMMAND);
      // Restarting dev servers on wake is a convenience; a failure must not block the thread.
      await installDevServerKeeper(box).catch(() => undefined);
      return box;
    })
    .finally(() => pendingSetups.delete(key));
  pendingSetups.set(key, promise);
  return promise;
}

export type BoxSetupStep =
  | "connect"
  | "create"
  | "check"
  | "install"
  | "credentials"
  | "clone"
  | "snapshot-fallback";

export const ensureBox = Effect.fn("UpstashBox.ensureBox")(function* (
  config: BoxRuntimeConfig,
  name: string,
  repositoryUrl?: string,
  onProgress: (step: BoxSetupStep) => void = () => {},
) {
  const api = yield* BoxApi;
  if (!config.apiKey.trim()) return yield* new BoxRuntimeError({ operation: "authenticate" });
  const configureBoxGit = yield* makeBoxGitSetup;
  return yield* Effect.tryPromise({
    try: () =>
      shareSetup(
        `${NodeCrypto.createHash("sha256").update(config.apiKey).digest("hex")}:${name}`,
        async () => {
          let box: BoxHandle;
          let snapshotUnavailable = false;
          onProgress("connect");
          try {
            box = await api.get(name, config.apiKey);
            if (config.credentials) await box.getStatus();
          } catch (error) {
            if (!isMissingBox(error)) throw error;
            onProgress("create");
            const createConfig: BoxConfig = config.credentials
              ? {
                  name,
                  apiKey: config.apiKey,
                  size: config.size,
                  runtime: "node",
                  keepAlive: false,
                  labels: ["crate"],
                  networkPolicy: { mode: "allow-all" },
                }
              : boxConfig({ ...config, name, ...(repositoryUrl ? { repositoryUrl } : {}) });
            const create = async () => {
              if (!config.snapshotId) return api.create({ ...createConfig, browser: true });
              try {
                if (!api.restore) throw new BoxRuntimeError({ operation: "create" });
                return await api.restore(config.snapshotId, createConfig);
              } catch (error) {
                if (!isStaleSnapshot(error)) throw error;
                snapshotUnavailable = true;
                onProgress("snapshot-fallback");
                return api.create({ ...createConfig, browser: true });
              }
            };
            box = await create().catch((createError: unknown) => {
              if (!isMissingStoredKey(createError)) throw createError;
              throw new BoxRuntimeError({
                operation: "create",
                statusCode: 400,
                missingStoredKey: true,
              });
            });
          }
          try {
            if (config.credentials) {
              await prepareThreadBox(
                box,
                config,
                repositoryUrl,
                onProgress,
                () => configureBoxGit(box, config.githubToken),
                snapshotUnavailable,
              );
              return box;
            }
            const installHarness = () =>
              box.files.write({
                path: "/home/boxuser/.local/bin/crate-harness.mjs",
                content: commandCodeHarness,
              });
            onProgress("check");
            const commandCode = config.harness === "commandCode";
            const checks = [
              `test -f ${BOOTSTRAPPED_MARKER}`,
              ...(commandCode
                ? [
                    "test -f /home/boxuser/.local/bin/crate-harness.mjs",
                    "test -x /home/boxuser/.local/bin/command-code",
                    "test -f /home/boxuser/.commandcode/auth.json",
                    `test -L ${BOX_HOME}/.commandcode/auth.json`,
                    `test -L ${BOX_HOME}/.commandcode/config.json`,
                    `test -f ${BOX_COMMAND_CODE_HOME}/.commandcode/auth.json`,
                    `test -f ${BOX_COMMAND_CODE_HOME}/.commandcode/config.json`,
                  ]
                : []),
              ...(repositoryUrl ? ["test -d /workspace/home/repo/.git"] : []),
            ];
            const ready = await box.exec.command(checks.join(" && "));
            if (ready.exitCode === 0) {
              await configureBoxGit(box, config.githubToken);
              if (commandCode) await installHarness();
              return box;
            }
            if (commandCode) {
              onProgress("install");
              const template = await api.get(config.templateBoxName, config.apiKey);
              await installCommandCode(box, template);
              await installHarness();
            }
            onProgress("credentials");
            await configureBoxGit(box, config.githubToken);
            if (repositoryUrl) {
              onProgress("clone");
              const quoted = `'${repositoryUrl.replaceAll("'", "'\\''")}'`;
              const clone = await box.exec.command(
                `test -d /workspace/home/repo/.git || git clone -- ${quoted} /workspace/home/repo`,
              );
              if (clone.exitCode !== 0) throw new Error("Repository clone failed.");
            }
            const marked = await box.exec.command(`touch ${BOOTSTRAPPED_MARKER}`);
            if (marked.exitCode !== 0) throw new Error("Box bootstrap could not be recorded.");
            return box;
          } catch {
            // SDK errors can include request bodies containing the template credentials.
            throw new Error("Could not bootstrap the Box.");
          }
        },
      ),
    catch: (error) =>
      isBoxRuntimeError(error) && error.missingStoredKey
        ? error
        : new BoxRuntimeError({
            operation: "bootstrap",
            ...(error instanceof BoxError && error.statusCode !== undefined
              ? { statusCode: error.statusCode }
              : {}),
          }),
  });
});

export const BOX_HARNESS_PATH = `${BOX_HOME}/.local/bin/crate-harness.mjs`;
export const BOX_MANAGED_HARNESS_PATH = `${BOX_HOME}/.local/bin/crate-managed.mjs`;
export const BOX_PROVIDER_WORKER_PATH = `${BOX_HOME}/.local/lib/crate-provider/worker.mjs`;
export const cliPackages = {
  commandCode: { bin: "command-code", package: "command-code@1.91.1" },
  claudeCode: { bin: "claude", package: "@anthropic-ai/claude-code@2.1.80" },
  codex: { bin: "codex", package: "@openai/codex@0.115.0" },
  opencode: { bin: "opencode", package: "opencode-ai@1.19.6" },
} as const;

function credentialSelection(config: BoxRuntimeConfig): BoxHarnessCredentials {
  return {
    ...config.credentials,
    ...(config.agentApiKey && !config.credentials?.[config.harness]
      ? { [config.harness]: config.agentApiKey }
      : {}),
  };
}

export function installHarnessCli(box: Pick<BoxHandle, "exec">, harness: BoxHarness) {
  if (harness === "antigravity") return Promise.resolve();
  if (harness === "cursor") {
    return requireCommand(
      box,
      `test -f ${BOX_HOME}/.local/lib/crate-provider/node_modules/@cursor/sdk/package.json || npm i --prefix ${BOX_HOME}/.local/lib/crate-provider --no-save --no-package-lock @cursor/sdk@1.3.1`,
    );
  }
  const cli = cliPackages[harness];
  return requireCommand(
    box,
    `test -x ${BOX_HOME}/.local/bin/${cli.bin} || npm i -g --prefix ${BOX_HOME}/.local ${cli.package}`,
  );
}

export async function installConnectedHarnesses(
  box: BoxHandle,
  config: BoxRuntimeConfig,
  onProgress: (step: BoxSetupStep) => void,
): Promise<void> {
  const credentials = credentialSelection(config);
  const workerHarnesses: readonly WorkerBoxHarness[] = ["opencode", "cursor", "antigravity"];
  const harnesses = [
    ...(Object.keys(cliPackages) as (keyof typeof cliPackages)[]),
    "cursor",
    "antigravity",
  ] as const;
  const connected = harnesses.flatMap((harness) => {
    const value = credentials[harness] ?? "";
    const kind = harnessCredentialKind(harness, value);
    return kind ? [{ harness, value, kind }] : [];
  });
  onProgress("install");
  await requireCommand(box, `mkdir -p ${BOX_HOME}/.local/bin`);
  for (const harness of new Set([
    ...connected.map(({ harness }) => harness),
    ...(isWorkerBoxHarness(config.harness) ? [config.harness] : []),
  ])) {
    await installHarnessCli(box, harness);
  }
  if (
    config.workerArtifact &&
    (isWorkerBoxHarness(config.harness) ||
      connected.some(({ harness }) => isWorkerBoxHarness(harness)))
  ) {
    const content = await config.workerArtifact();
    const digest = NodeCrypto.createHash("sha256").update(content).digest("hex");
    const staged = `${BOX_PROVIDER_WORKER_PATH}.${digest}.mjs`;
    if ((await box.exec.command(`test -f ${staged}`)).exitCode !== 0) {
      await requireCommand(box, `mkdir -p ${BOX_HOME}/.local/lib/crate-provider`);
      await box.files.write({ path: `${staged}.upload`, content });
      await requireCommand(box, `mv -f -- ${staged}.upload ${staged}`);
    }
    await requireCommand(box, `ln -sfnT ${staged} ${BOX_PROVIDER_WORKER_PATH}`);
  }
  if (connected.some(({ harness }) => harness === "commandCode")) {
    await box.files.write({ path: BOX_HARNESS_PATH, content: commandCodeHarness });
  }
  if (connected.some(({ harness }) => harness === "claudeCode" || harness === "codex")) {
    await box.files.write({ path: BOX_MANAGED_HARNESS_PATH, content: managedHarness });
  }

  onProgress("credentials");
  const writeVolatile = box.files.writeVolatile;
  if (!writeVolatile) throw new Error("Box does not support volatile credentials.");
  await requireCommand(
    box,
    `test "$(stat -f -c %T /dev/shm)" = tmpfs && umask 077 && mkdir -p ${BOX_CREDENTIALS_DIR}/codex ${BOX_CREDENTIALS_DIR}/claude ${BOX_COMMAND_CODE_HOME}/.commandcode`,
  );
  await requireCommand(
    box,
    `ln -sfnT ${BOX_CREDENTIALS_DIR}/claude/.claude.json ${BOX_HOME}/.claude.json`,
  );
  for (const harness of workerHarnesses) {
    const directory = `${BOX_CREDENTIALS_DIR}/${harness}`;
    const credential = connected.find((value) => value.harness === harness);
    const path = `${directory}/credential`;
    await requireCommand(box, `umask 077 && mkdir -p ${directory}`);
    if (credential) await writeVolatile(path, credential.value);
    else await requireCommand(box, `rm -f -- ${path}`);
  }
  for (const harness of ["commandCode", "claudeCode", "codex"] as const) {
    const credential = connected.find((entry) => entry.harness === harness);
    const stamp = `${BOX_CREDENTIALS_DIR}/${harness}.sha256`;
    const directory = BOX_CREDENTIALS_DIR;
    const files =
      harness === "claudeCode"
        ? [
            `${directory}/claudeCode-key`,
            `${directory}/claudeCode-token`,
            `${directory}/claude/.credentials.json`,
          ]
        : harness === "commandCode"
          ? [`${BOX_COMMAND_CODE_HOME}/.commandcode/auth.json`, `${directory}/commandCode-key`]
          : [`${directory}/codex/auth.json`];
    if (harness === "commandCode") {
      await requireCommand(
        box,
        [
          `mkdir -p ${BOX_HOME}/.commandcode/projects`,
          ...["auth.json", "config.json"].map(
            (file) =>
              `ln -sfnT ${BOX_COMMAND_CODE_HOME}/.commandcode/${file} ${BOX_HOME}/.commandcode/${file}`,
          ),
          ...[".commandcode/projects", ".gitconfig"].map(
            (path) => `ln -sfnT ${BOX_HOME}/${path} ${BOX_COMMAND_CODE_HOME}/${path}`,
          ),
        ].join(" && "),
      );
    } else {
      const home = harness === "codex" ? ".codex" : ".claude";
      const persistent = harness === "codex" ? "sessions" : "projects";
      const target = harness === "codex" ? "codex" : "claude";
      const oldAuth = harness === "codex" ? "auth.json" : ".credentials.json";
      await requireCommand(
        box,
        `mkdir -p ${BOX_HOME}/${home}/${persistent} && ln -sfnT ${directory}/${target}/${oldAuth} ${BOX_HOME}/${home}/${oldAuth} && ln -sfn ${BOX_HOME}/${home}/${persistent} ${directory}/${target}/${persistent}`,
      );
    }
    if (!credential) {
      await requireCommand(
        box,
        `if test -f ${stamp}; then rm -f -- ${stamp} ${files.join(" ")}; fi`,
      );
      continue;
    }
    const { value, kind } = credential;
    const path =
      harness === "claudeCode"
        ? kind === "file"
          ? files[2]!
          : `${directory}/claudeCode-${kind}`
        : harness === "commandCode" && kind === "key"
          ? files[1]!
          : files[0]!;
    // A CLI can refresh its own login. Only replace it when the saved settings change.
    const digest = NodeCrypto.createHash("sha256").update(value).digest("hex");
    const ready = await box.exec.command(
      `test -f ${stamp} && test -s ${path} && test "$(cat ${stamp})" = ${digest}`,
    );
    if (ready.exitCode === 0) continue;
    await requireCommand(box, `mkdir -p ${directory} && chmod 700 ${directory}`);
    await writeVolatile(
      path,
      harness === "codex" && kind === "key"
        ? JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: value })
        : value,
    );
    await requireCommand(box, `chmod 600 ${path}`);
    if (files.length > 1) {
      await requireCommand(box, `rm -f -- ${files.filter((file) => file !== path).join(" ")}`);
    }
    await writeVolatile(stamp, digest);
  }
}

async function prepareThreadBox(
  box: BoxHandle,
  config: BoxRuntimeConfig,
  repositoryUrl: string | undefined,
  onProgress: (step: BoxSetupStep) => void,
  configureGit: () => Promise<void>,
  snapshotUnavailable: boolean,
) {
  onProgress("check");
  if (config.snapshotId && !snapshotUnavailable) {
    const repo = "/workspace/home/repo";
    await requireCommand(
      box,
      repositoryUrl
        ? `test ! -e ${repo}/.git || test "$(git -C ${repo} remote get-url origin)" = ${quoteShell(repositoryUrl)}`
        : `test ! -e ${repo}/.git`,
    );
  }
  const bootstrapped = await box.exec.command(
    `test -f ${BOOTSTRAPPED_MARKER}${repositoryUrl ? " && test -e /workspace/home/repo/.git" : ""}`,
  );
  await installConnectedHarnesses(box, config, onProgress);
  await configureGit();
  if (bootstrapped.exitCode === 0) return;
  if (repositoryUrl) {
    onProgress("clone");
    await requireCommand(
      box,
      `test -e /workspace/home/repo/.git || git clone -- ${quoteShell(repositoryUrl)} /workspace/home/repo`,
    );
  }
  await requireCommand(box, `touch ${BOOTSTRAPPED_MARKER}`);
}

async function installCommandCode(box: BoxHandle, template: BoxHandle) {
  const install = await box.exec.command(
    "npm i -g --prefix /home/boxuser/.local command-code@1.91.1",
  );
  if (install.exitCode !== 0) throw new Error("Command Code installation failed.");
  const mkdir = await box.exec.command(
    `test "$(stat -f -c %T /dev/shm)" = tmpfs && umask 077 && mkdir -p ${BOX_HOME}/.commandcode/projects ${BOX_HOME}/.local/bin ${BOX_COMMAND_CODE_HOME}/.commandcode && chmod 700 ${BOX_HOME}/.commandcode`,
  );
  if (mkdir.exitCode !== 0) throw new Error("Box workspace setup failed.");
  const writeVolatile = box.files.writeVolatile;
  if (!writeVolatile) throw new Error("Box does not support volatile credentials.");
  for (const file of ["auth.json", "config.json"]) {
    const source = `~/.commandcode/${file}`;
    const result = await template.exec.command(`cat ${source}`);
    if (result.exitCode !== 0 || !result.stdout)
      throw new Error("Template bootstrap file is unavailable.");
    await writeVolatile(`${BOX_COMMAND_CODE_HOME}/.commandcode/${file}`, result.stdout);
    await requireCommand(
      box,
      `ln -sfnT ${BOX_COMMAND_CODE_HOME}/.commandcode/${file} ${BOX_HOME}/.commandcode/${file}`,
    );
  }
  await requireCommand(
    box,
    `ln -sfnT ${BOX_HOME}/.commandcode/projects ${BOX_COMMAND_CODE_HOME}/.commandcode/projects && ln -sfnT ${BOX_HOME}/.gitconfig ${BOX_COMMAND_CODE_HOME}/.gitconfig`,
  );
  const permissions = await box.exec.command(
    "chmod 600 /home/boxuser/.commandcode/auth.json /home/boxuser/.commandcode/config.json",
  );
  if (permissions.exitCode !== 0) throw new Error("Box credential permissions could not be set.");
}
