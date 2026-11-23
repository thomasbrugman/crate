import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ThreadId, type BoxSnapshot, type EnvironmentId, type ProjectId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import { useGT } from "gt-react";
import { useEffect, useEffectEvent, useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useQuietThreadShell } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { SettingsRow } from "./settingsLayout";

export function ProjectBoxSetup({
  environmentId,
  projectId,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
}) {
  const gt = useGT();
  const settings = useEnvironmentSettings(environmentId);
  const overrides = settings.projectSettingsOverrides[projectId];
  const snapshotId = overrides?.upstashBoxSnapshotId;
  const setupId = overrides?.upstashBoxSetupThreadId;
  const setupThread = useQuietThreadShell(
    setupId ? scopeThreadRef(environmentId, ThreadId.make(setupId)) : null,
  );
  const canSave = useAtomValue(
    serverEnvironment.saveProjectBoxSnapshot.permissionAtom(environmentId),
  );
  const list = useAtomCommand(serverEnvironment.listBoxSnapshots, { reportFailure: false });
  const [snapshots, setSnapshots] = useState<ReadonlyArray<BoxSnapshot>>([]);
  const [starting, setStarting] = useState(false);
  const startThread = useNewThreadHandler();
  const load = useEffectEvent(async (signal: AbortSignal) => {
    const result = await list({ environmentId, input: {} }, { signal });
    if (!signal.aborted && result._tag === "Success") setSnapshots(result.value.snapshots);
  });
  const snapshotKey = snapshotId ? `${environmentId}:${snapshotId}` : "";
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Fetch external snapshot metadata when the project's snapshot changes.
  useEffect(() => {
    if (!canSave || !snapshotKey) return;
    const controller = new AbortController();
    // oxlint-disable-next-line react/set-state-in-effect -- Metadata arrives asynchronously from the Box service.
    void load(controller.signal);
    return () => controller.abort();
  }, [snapshotKey, canSave]);
  const snapshot = snapshots.find((candidate) => candidate.id === snapshotId);
  return (
    <SettingsRow
      title={gt("Environment setup")}
      description={
        snapshotId
          ? `${settings.upstashBox.snapshotNames[snapshotId] || snapshot?.name || snapshotId}${snapshot ? ` · ${new Date(snapshot.createdAt * 1000).toLocaleString()}` : ""}`
          : gt("No project snapshot yet; new threads start on a fresh Box")
      }
      control={
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={!canSave || starting}
            onClick={async () => {
              setStarting(true);
              try {
                await startThread(scopeProjectRef(environmentId, projectId), {
                  envMode: "local",
                  branch: null,
                  worktreePath: null,
                  boxSize: "large",
                  prompt: gt(
                    "Prepare this project's environment: install dependencies, configure the toolchain, run the project's checks, and report when ready to save as a project snapshot. Do not save the snapshot yourself.",
                  ),
                });
              } catch {
                toastManager.add({ type: "error", title: gt("Could not create setup thread") });
              }
              setStarting(false);
            }}
          >
            {gt("Start setup thread")}
          </Button>
          {setupThread ? (
            <Link
              className="text-sm text-primary underline underline-offset-4"
              to="/$environmentId/$threadId"
              params={{ environmentId, threadId: setupThread.id }}
            >
              {gt("Open setup thread")}
            </Link>
          ) : null}
        </div>
      }
    />
  );
}
