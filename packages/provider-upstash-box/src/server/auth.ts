import { ProviderSetupError, type ProviderInstanceId } from "@t3tools/contracts";
import * as ProviderAuthFlow from "@t3tools/provider-core/server/providerAuthFlow";
import type { ProviderHost } from "@t3tools/provider-core/server/ProviderHost";
import { EphemeralBox } from "@upstash/box";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";

import { BOX_HARNESS_LABELS, type BoxHarness } from "../harnesses.ts";
import type { BoxEnvironmentConfig } from "./adapter.ts";
import { BOX_HOME } from "./BoxApi.ts";
import { cliPackages } from "./bootstrap.ts";
import { BOX_HARNESS_AUTH_FIELDS, isAuthJson } from "./credentials.ts";

const login = {
  commandCode: { args: ["login"], file: ".commandcode/auth.json" },
  claudeCode: { args: ["auth", "login", "--claudeai"], file: ".claude/.credentials.json" },
  codex: { args: ["login", "--device-auth"], file: ".codex/auth.json" },
} as const;

export const makeBoxHarnessAuth = Effect.fn("UpstashBox.makeAuth")(function* (
  instanceId: ProviderInstanceId,
  harness: BoxHarness,
  environment: Effect.Effect<BoxEnvironmentConfig>,
  updateSettings: NonNullable<ProviderHost["Service"]["settings"]["update"]>,
) {
  const failure = (operation: "start" | "respond" | "logout", detail: string) =>
    new ProviderSetupError({ instanceId, operation, detail });
  const save = (value: string, operation: "start" | "logout") =>
    updateSettings({ upstashBox: { [BOX_HARNESS_AUTH_FIELDS[harness]]: value } }).pipe(
      Effect.asVoid,
      Effect.mapError(() => failure(operation, "Could not save the harness connection.")),
    );
  const methodId = "box-terminal";
  return yield* ProviderAuthFlow.make({
    instanceId,
    credentialBinding: { owner: "t3", key: `upstash-box:${harness}` },
    defaultMethodId: methodId,
    methods: Effect.succeed([
      { id: methodId, name: "Box terminal", description: null, type: "terminal" },
    ]),
    authenticate: Effect.fn("UpstashBox.authenticate")(function* (_methodId, context) {
      const { apiKey } = yield* environment;
      if (!apiKey) return yield* failure("start", "Set an Upstash Box API key first.");
      yield* context.setProgress("Creating the sign-in Box.");
      const box = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () =>
            EphemeralBox.create({
              apiKey,
              runtime: "node",
              ttl: 600,
              labels: ["t3stash-auth"],
              networkPolicy: { mode: "allow-all" },
            }),
          catch: () => failure("start", "Could not create the temporary sign-in Box."),
        }),
        (box) =>
          Effect.tryPromise({ try: () => box.delete(), catch: () => undefined }).pipe(
            Effect.ignore,
          ),
      );
      const cli = cliPackages[harness];
      yield* context.setProgress(
        `Installing ${BOX_HARNESS_LABELS[harness]}. This may take a minute.`,
      );
      yield* Effect.tryPromise({
        try: async () => {
          const setup = await box.exec.command(
            `npm i -g --prefix ${BOX_HOME}/.local ${cli.package}`,
          );
          if (setup.exitCode !== 0) throw new Error("Sign-in CLI installation failed.");
        },
        catch: () => failure("start", "Could not install the sign-in CLI."),
      });
      const output = yield* Queue.sliding<string>(64);
      const decoder = new TextDecoder();
      yield* context.setProgress("Opening the sign-in terminal.");
      const session = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () =>
            box.exec.session({
              argv: [`${BOX_HOME}/.local/bin/${cli.bin}`, ...login[harness].args],
              env: [`HOME=${BOX_HOME}`, `CODEX_HOME=${BOX_HOME}/.codex`, "BROWSER=/bin/false"],
              tty: true,
              cols: 80,
              rows: 24,
              onStdout: (bytes) => {
                const chunk = decoder.decode(bytes, { stream: true });
                Queue.offerUnsafe(output, chunk);
              },
            }),
          catch: () => failure("start", "Could not open the Box sign-in terminal."),
        }),
        (session) =>
          Effect.try({ try: () => session.close(), catch: () => undefined }).pipe(Effect.ignore),
      );
      let transcript = "";
      let outputOffset = 0;
      const update = () =>
        context.setInteraction(
          { type: "terminal", id: methodId, output: transcript, outputOffset },
          (response) =>
            response.type !== "terminal"
              ? Effect.void
              : Effect.try({
                  try: () => {
                    if (response.size) session.resize(response.size.rows, response.size.cols);
                    if (response.data)
                      session.write(
                        response.binary ? Buffer.from(response.data, "latin1") : response.data,
                      );
                  },
                  catch: () => failure("respond", "The Box sign-in terminal closed."),
                }),
        );
      yield* update();
      yield* Queue.take(output).pipe(
        Effect.flatMap((chunk) => {
          outputOffset += chunk.length;
          transcript = (transcript + chunk).slice(-16_384);
          return update();
        }),
        Effect.forever,
        Effect.forkScoped,
      );
      const exitCode = yield* Effect.tryPromise({
        try: () => session.wait(),
        catch: () => failure("start", "The Box sign-in terminal closed."),
      });
      if (exitCode !== 0) return yield* failure("start", "Sign-in did not finish successfully.");
      yield* context.verifying;
      const credential = yield* Effect.tryPromise({
        try: async () => {
          const value = (
            await box.files.read(`${BOX_HOME}/${login[harness].file}`, { length: 16_384 })
          ).trim();
          if (!isAuthJson(value)) throw new Error("No credentials returned.");
          return value;
        },
        catch: () => failure("start", "The harness did not return a saved login."),
      });
      yield* save(credential, "start");
    }),
    logout: save("", "logout"),
  });
});
