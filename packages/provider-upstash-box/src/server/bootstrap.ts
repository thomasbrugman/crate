import type { BoxConfig } from "@upstash/box";
import * as Effect from "effect/Effect";
import { BoxApi, BoxRuntimeError, boxConfig, isMissingBox, type BoxHandle } from "./BoxApi.ts";

export interface BoxRuntimeConfig {
  readonly apiKey: string;
  readonly templateBoxName: string;
  readonly model: string;
  readonly size: NonNullable<BoxConfig["size"]>;
}

export const ensureBox = Effect.fn("UpstashBox.ensureBox")(function* (
  config: BoxRuntimeConfig,
  name: string,
) {
  const api = yield* BoxApi;
  return yield* Effect.tryPromise({
    try: async () => {
      let box: BoxHandle;
      try {
        box = await api.get(name, config.apiKey);
      } catch (error) {
        if (!isMissingBox(error)) throw new BoxRuntimeError({ operation: "get" });
        box = await api.create(boxConfig({ ...config, name }));
      }
      try {
        const ready = await box.exec.command(
          "test -f /home/boxuser/.local/bin/t3stash-harness.mjs && test -x /home/boxuser/.local/bin/command-code && test -f /home/boxuser/.commandcode/auth.json",
        );
        if (ready.exitCode === 0) return box;
        const template = await api.get(config.templateBoxName, config.apiKey);
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
          ["~/.local/bin/boxjob-cc-harness.mjs", "/home/boxuser/.local/bin/t3stash-harness.mjs"],
        ] as const) {
          const result = await template.exec.command(`cat ${source}`);
          if (result.exitCode !== 0 || !result.stdout)
            throw new Error("Template bootstrap file is unavailable.");
          await box.files.write({ path: destination, content: result.stdout });
        }
        const permissions = await box.exec.command(
          "chmod 600 /home/boxuser/.commandcode/auth.json /home/boxuser/.commandcode/config.json",
        );
        if (permissions.exitCode !== 0)
          throw new Error("Box credential permissions could not be set.");
        return box;
      } catch {
        // SDK errors can include request bodies containing the template credentials.
        throw new Error("Could not bootstrap the Command Code Box from its template.");
      }
    },
    catch: () => new BoxRuntimeError({ operation: "bootstrap" }),
  });
});
