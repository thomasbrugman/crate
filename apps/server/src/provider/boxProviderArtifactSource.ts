// @effect-diagnostics nodeBuiltinImport:off -- Resolve the checkout-relative worker entry for Vite.
import * as NodeURL from "node:url";
import { build } from "vite-plus";

let artifact: Promise<string> | undefined;

export function boxProviderArtifact(): Promise<string> {
  artifact ??= build({
    configFile: false,
    logLevel: "error",
    ssr: { noExternal: true, external: ["@cursor/sdk"] },
    resolve: { alias: { "jsonc-parser": "jsonc-parser/lib/esm/main.js" } },
    build: {
      ssr: NodeURL.fileURLToPath(new URL("../box-provider-worker.ts", import.meta.url)),
      write: false,
      target: "node26",
      rolldownOptions: { output: { codeSplitting: false } },
    },
  })
    .then((result) => {
      const bundles = Array.isArray(result) ? result : [result];
      const files = bundles.flatMap((bundle) => ("output" in bundle ? bundle.output : []));
      const entry = files[0];
      if (files.length !== 1 || entry?.type !== "chunk") {
        throw new Error("The Box provider worker must bundle to one module.");
      }
      return entry.code;
    })
    .catch((error: unknown) => {
      artifact = undefined;
      throw error;
    });
  return artifact;
}
