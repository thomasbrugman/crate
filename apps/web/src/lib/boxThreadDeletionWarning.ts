import { isUpstashBoxDriver } from "@t3tools/client-runtime/provider-clients";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { msg } from "gt-react";

import { m } from "../i18n/messages";
import { readEnvironmentProviders } from "../state/environments";

type DeletionThread = Pick<
  EnvironmentThreadShell,
  "environmentId" | "runtime" | "modelSelection" | "providerInstanceHistory"
>;

export function boxThreadDeletionWarning(threads: ReadonlyArray<DeletionThread>): string | null {
  const hasBoxThread = threads.some((thread) =>
    readEnvironmentProviders(thread.environmentId)?.some(
      (provider) =>
        isUpstashBoxDriver(provider.driver) &&
        (provider.instanceId ===
          (thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId) ||
          thread.providerInstanceHistory.includes(provider.instanceId)),
    ),
  );
  return hasBoxThread
    ? m(
        msg(
          "Deleting a cloud thread also permanently deletes its Box and any unpushed changes in it.",
        ),
      )
    : null;
}
