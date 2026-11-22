import { BoxError, type BoxConfig } from "@upstash/box";
// @effect-diagnostics-next-line nodeBuiltinImport:off - The SDK setup boundary uses promises.
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { BoxHarness } from "../harnesses.ts";
import {
  BoxApi,
  BoxRuntimeError,
  boxConfig,
  isMissingBox,
  isMissingStoredKey,
  type BoxHandle,
} from "./BoxApi.ts";
import { commandCodeHarness } from "./harness.ts";
import { managedHarness } from "./managedHarness.ts";
import {
  BOX_CREDENTIALS_DIR,
  BOX_COMMAND_CODE_HOME,
  harnessCredentialKind,
  type BoxHarnessCredentials,
} from "./credentials.ts";

const isBoxRuntimeError = Schema.is(BoxRuntimeError);

/** The thread's Box environment plus the agent that runs inside it. */
export interface BoxRuntimeConfig {
  readonly apiKey: string;
  readonly templateBoxName: string;
  readonly size: NonNullable<BoxConfig["size"]>;
  readonly harness: BoxHarness;
  readonly model: string;
  readonly agentApiKey: string;
  readonly credentials?: BoxHarnessCredentials;
  readonly snapshotId?: string;
}

const BOOTSTRAPPED_MARKER = "/home/boxuser/.t3stash-bootstrapped";
const pendingSetups = new Map<string, Promise<BoxHandle>>();

function shareSetup(key: string, setup: () => Promise<BoxHandle>): Promise<BoxHandle> {
  const pending = pendingSetups.get(key);
  if (pending) return pending;
  const promise = setup().finally(() => pendingSetups.delete(key));
  pendingSetups.set(key, promise);
  return promise;
}

export type BoxSetupStep = "connect" | "create" | "check" | "install" | "credentials" | "clone";

export const ensureBox = Effect.fn("UpstashBox.ensureBox")(function* (
  config: BoxRuntimeConfig,
  name: string,
  repositoryUrl?: string,
  onProgress: (step: BoxSetupStep) => void = () => {},
) {
  const api = yield* BoxApi;
  if (!config.apiKey.trim()) return yield* new BoxRuntimeError({ operation: "authenticate" });
  return yield* Effect.tryPromise({
    try: () =>
      shareSetup(
        `${NodeCrypto.createHash("sha256").update(config.apiKey).digest("hex")}:${name}`,
        async () => {
          let box: BoxHandle;
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
                  labels: ["t3stash"],
                  networkPolicy: { mode: "allow-all" },
                }
              : boxConfig({ ...config, name, ...(repositoryUrl ? { repositoryUrl } : {}) });
            box = await (
              config.snapshotId
                ? (api.restore?.(config.snapshotId, createConfig) ??
                  Promise.reject(new BoxRuntimeError({ operation: "create" })))
                : api.create(createConfig)
            ).catch((createError: unknown) => {
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
              await prepareThreadBox(box, config, repositoryUrl, onProgress, api);
              return box;
            }
            const installHarness = () =>
              box.files.write({
                path: "/home/boxuser/.local/bin/t3stash-harness.mjs",
                content: commandCodeHarness,
              });
            onProgress("check");
            const commandCode = config.harness === "commandCode";
            const checks = [
              `test -f ${BOOTSTRAPPED_MARKER}`,
              ...(commandCode
                ? [
                    "test -f /home/boxuser/.local/bin/t3stash-harness.mjs",
                    "test -x /home/boxuser/.local/bin/command-code",
                    "test -f /home/boxuser/.commandcode/auth.json",
                  ]
                : []),
              ...(repositoryUrl ? ["test -d /workspace/home/repo/.git"] : []),
            ];
            const ready = await box.exec.command(checks.join(" && "));
            if (ready.exitCode === 0) {
              if (commandCode) await installHarness();
              return box;
            }
            const template = await api.get(config.templateBoxName, config.apiKey);
            if (commandCode) {
              onProgress("install");
              await installCommandCode(box, template);
              await installHarness();
            }
            onProgress("credentials");
            for (const file of [".git-credentials", ".gitconfig"]) {
              const result = await template.exec.command(`test ! -f ~/${file} || cat ~/${file}`);
              if (result.exitCode !== 0)
                throw new Error("Template Git configuration is unavailable.");
              if (result.stdout) {
                await box.files.write({ path: `/home/boxuser/${file}`, content: result.stdout });
                const permissions = await box.exec.command(`chmod 600 /home/boxuser/${file}`);
                if (permissions.exitCode !== 0)
                  throw new Error("Git credential permissions could not be set.");
              }
            }
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
            throw new Error("Could not bootstrap the Box from its template.");
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

export const BOX_HOME = "/home/boxuser";
export const BOX_HARNESS_PATH = `${BOX_HOME}/.local/bin/t3stash-harness.mjs`;
export const BOX_MANAGED_HARNESS_PATH = `${BOX_HOME}/.local/bin/t3stash-managed.mjs`;
export const cliPackages = {
  commandCode: { bin: "command-code", package: "command-code@1.91.1" },
  claudeCode: { bin: "claude", package: "@anthropic-ai/claude-code@2.1.80" },
  codex: { bin: "codex", package: "@openai/codex@0.115.0" },
} as const;

export const quoteShell = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

function credentialSelection(config: BoxRuntimeConfig): BoxHarnessCredentials {
  return {
    ...config.credentials,
    ...(config.agentApiKey && !config.credentials?.[config.harness]
      ? { [config.harness]: config.agentApiKey }
      : {}),
  };
}

export async function requireCommand(box: Pick<BoxHandle, "exec">, command: string): Promise<void> {
  if ((await box.exec.command(command)).exitCode !== 0)
    throw new Error("Box setup command failed.");
}

export function installHarnessCli(box: Pick<BoxHandle, "exec">, harness: BoxHarness) {
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
  const connected = (Object.keys(cliPackages) as BoxHarness[]).flatMap((harness) => {
    const value = credentials[harness] ?? "";
    const kind = harnessCredentialKind(harness, value);
    return kind ? [{ harness, value, kind }] : [];
  });
  onProgress("install");
  await requireCommand(box, `mkdir -p ${BOX_HOME}/.local/bin`);
  for (const { harness } of connected) {
    await installHarnessCli(box, harness);
  }
  if (connected.some(({ harness }) => harness === "commandCode")) {
    await box.files.write({ path: BOX_HARNESS_PATH, content: commandCodeHarness });
  }
  if (connected.some(({ harness }) => harness !== "commandCode")) {
    await box.files.write({ path: BOX_MANAGED_HARNESS_PATH, content: managedHarness });
  }

  onProgress("credentials");
  const writeVolatile = box.files.writeVolatile;
  if (!writeVolatile) throw new Error("Box does not support volatile credentials.");
  await requireCommand(
    box,
    `test "$(stat -f -c %T /dev/shm)" = tmpfs && umask 077 && mkdir -p ${BOX_CREDENTIALS_DIR}/codex ${BOX_CREDENTIALS_DIR}/claude ${BOX_COMMAND_CODE_HOME}/.commandcode`,
  );
  for (const harness of Object.keys(cliPackages) as BoxHarness[]) {
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
          `rm -f -- ${BOX_HOME}/.commandcode/auth.json`,
          ...[".commandcode/projects", ".gitconfig", ".git-credentials"].map(
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
        `mkdir -p ${BOX_HOME}/${home}/${persistent} && rm -f -- ${BOX_HOME}/${home}/${oldAuth} && ln -sfn ${BOX_HOME}/${home}/${persistent} ${directory}/${target}/${persistent}`,
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
  api: BoxApi["Service"],
) {
  onProgress("check");
  if (config.snapshotId) {
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
  if (bootstrapped.exitCode === 0) return;
  if (repositoryUrl && config.templateBoxName) {
    const template = await api
      .get(config.templateBoxName, config.apiKey)
      .catch((error: unknown) => {
        if (!isMissingBox(error)) throw error;
        return undefined;
      });
    for (const file of [".git-credentials", ".gitconfig"]) {
      if (!template) break;
      const result = await template.exec.command(`test ! -f ~/${file} || cat ~/${file}`);
      if (result.exitCode !== 0) throw new Error("Template Git configuration is unavailable.");
      if (result.stdout) {
        await box.files.write({ path: `${BOX_HOME}/${file}`, content: result.stdout });
        await requireCommand(box, `chmod 600 ${BOX_HOME}/${file}`);
      }
    }
  }
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
    "mkdir -p /home/boxuser/.commandcode /home/boxuser/.local/bin && chmod 700 /home/boxuser/.commandcode",
  );
  if (mkdir.exitCode !== 0) throw new Error("Box workspace setup failed.");
  for (const [source, destination] of [
    ["~/.commandcode/auth.json", "/home/boxuser/.commandcode/auth.json"],
    ["~/.commandcode/config.json", "/home/boxuser/.commandcode/config.json"],
  ] as const) {
    const result = await template.exec.command(`cat ${source}`);
    if (result.exitCode !== 0 || !result.stdout)
      throw new Error("Template bootstrap file is unavailable.");
    await box.files.write({ path: destination, content: result.stdout });
  }
  const permissions = await box.exec.command(
    "chmod 600 /home/boxuser/.commandcode/auth.json /home/boxuser/.commandcode/config.json",
  );
  if (permissions.exitCode !== 0) throw new Error("Box credential permissions could not be set.");
}
