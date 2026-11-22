import { Config } from "@remotion/cli/config";
import { enableTailwind } from "@remotion/tailwind-v4";
import * as NodePath from "node:path";

Config.overrideWebpackConfig((config) =>
  enableTailwind({
    ...config,
    resolve: {
      ...config.resolve,
      alias: {
        ...config.resolve?.alias,
        "~/lib/utils$": NodePath.resolve("src/classNames.ts"),
        "gt-react$": NodePath.resolve("src/translations.ts"),
        "~": NodePath.resolve("../web/src"),
        react$: NodePath.resolve("node_modules/react"),
        "react-dom$": NodePath.resolve("node_modules/react-dom"),
      },
    },
  }),
);
