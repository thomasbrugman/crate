import { scopedThreadKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import { isUpstashBoxDriver } from "@t3tools/client-runtime/provider-clients";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AuthSettingsWriteScope,
  type ScopedThreadRef,
  SaveProjectBoxSnapshotError,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import * as Schema from "effect/Schema";
import { msg } from "gt-react";

import { m } from "../i18n/messages";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readProject, readThreadShell } from "../state/entities";
import { environmentServerConfigsAtom, serverEnvironment } from "../state/server";
import { readEnvironmentScope } from "../state/session";
import { providerInstanceEntriesFor } from "../providerInstances";
import { toastManager } from "../components/ui/toast";
import { projectSnapshotErrorMessage } from "../components/settings/projectBoxSnapshot.logic";

export const savingProjectSnapshotsAtom = Atom.make<ReadonlyArray<string>>([]).pipe(Atom.keepAlive);
const isSaveError = Schema.is(SaveProjectBoxSnapshotError);

export function readProjectSnapshotAction(
  threadRef: ScopedThreadRef | null,
  savingKeys = appAtomRegistry.get(savingProjectSnapshotsAtom),
) {
  if (!threadRef) return null;
  const thread = readThreadShell(threadRef);
  const config = appAtomRegistry.get(environmentServerConfigsAtom).get(threadRef.environmentId);
  if (!thread || !config) return null;
  if (thread.lineage.relationshipToParent === "subagent") return null;
  const provider = providerInstanceEntriesFor(
    config.providers,
    config.settings,
    thread.projectId,
  ).find((entry) => entry.instanceId === thread.providerInstanceId);
  if (!isUpstashBoxDriver(provider?.driverKind)) return null;
  const saving = savingKeys.includes(scopedThreadKey(threadRef));
  const reason = saving
    ? m(msg("Saving project snapshot… This can take a minute or more."))
    : threadRuntimeIsActive(thread.runtime)
      ? m(projectSnapshotErrorMessage("active-turn"))
      : !readEnvironmentScope(threadRef.environmentId, AuthSettingsWriteScope)
        ? m(msg("Settings-write permission is required."))
        : null;
  return { thread, reason };
}

export async function saveProjectSnapshot(threadRef: ScopedThreadRef): Promise<void> {
  const action = readProjectSnapshotAction(threadRef);
  if (!action || action.reason) return;
  const key = scopedThreadKey(threadRef);
  const project = readProject(scopeProjectRef(threadRef.environmentId, action.thread.projectId));
  appAtomRegistry.set(savingProjectSnapshotsAtom, [
    ...appAtomRegistry.get(savingProjectSnapshotsAtom),
    key,
  ]);
  const progress = toastManager.add({
    type: "loading",
    title: m(msg("Saving project snapshot… This can take a minute or more.")),
    timeout: 0,
  });
  try {
    const result = await runAtomCommand(
      appAtomRegistry,
      serverEnvironment.saveProjectBoxSnapshot,
      {
        environmentId: threadRef.environmentId,
        input: { projectId: action.thread.projectId, threadId: threadRef.threadId },
      },
      { reportFailure: false },
    );
    if (result._tag === "Success") {
      toastManager.add({
        type: "success",
        title: m(msg("Project snapshot saved")),
        description: m(msg("New threads in {project} will start from {name}"), {
          project: project?.title ?? action.thread.title,
          name: result.value.name ?? result.value.id,
        }),
      });
    } else {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: m(msg("Could not save project snapshot")),
        description: m(projectSnapshotErrorMessage(isSaveError(error) ? error.reason : undefined)),
      });
    }
  } finally {
    toastManager.close(progress);
    appAtomRegistry.set(
      savingProjectSnapshotsAtom,
      appAtomRegistry.get(savingProjectSnapshotsAtom).filter((candidate) => candidate !== key),
    );
  }
}
