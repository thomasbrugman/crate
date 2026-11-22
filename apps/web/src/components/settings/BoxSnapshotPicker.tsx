import { type BoxSnapshot, type EnvironmentId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useGT } from "gt-react";
import { RefreshCwIcon } from "lucide-react";
import { useEffect, useEffectEvent, useState } from "react";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

export function BoxSnapshotPicker({
  environmentId,
  value,
  onChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly value: string;
  readonly onChange: (id: string) => void;
}) {
  const gt = useGT();
  const canChoose = useAtomValue(serverEnvironment.listBoxSnapshots.permissionAtom(environmentId));
  const names = useEnvironmentSettings(
    environmentId,
    (settings) => settings.upstashBox.snapshotNames,
  );
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const listSnapshots = useAtomCommand(serverEnvironment.listBoxSnapshots, {
    reportFailure: false,
  });
  const [snapshots, setSnapshots] = useState<ReadonlyArray<BoxSnapshot>>([]);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState(false);
  const refresh = async (signal?: AbortSignal) => {
    const result = await listSnapshots(
      { environmentId, input: {} },
      signal ? { signal } : undefined,
    );
    if (signal?.aborted) return;
    if (result._tag === "Success") setSnapshots(result.value.snapshots);
    setError(result._tag !== "Success");
    setPending(false);
  };
  const loadOnMount = useEffectEvent(refresh);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Load this environment's external snapshot list when the picker mounts.
  useEffect(() => {
    if (!canChoose) return;
    const controller = new AbortController();
    // oxlint-disable-next-line react/set-state-in-effect -- State changes only after the snapshot response arrives.
    void loadOnMount(controller.signal);
    return () => controller.abort();
  }, [canChoose]);
  const selected = snapshots.find((snapshot) => snapshot.id === value);
  const snapshotName = (snapshot: (typeof snapshots)[number]) =>
    names[snapshot.id] || snapshot.name || gt("Unnamed snapshot");
  const selectedLabel = !value
    ? gt("Fresh Box (no snapshot)")
    : selected
      ? snapshotName(selected)
      : gt("Saved snapshot unavailable");

  return (
    <div className="w-full min-w-0 space-y-2 sm:w-80">
      <div className="flex min-w-0 items-center gap-2">
        <Select
          value={value}
          disabled={!canChoose || pending}
          onValueChange={(next) => {
            if (next !== null) onChange(next);
          }}
        >
          <SelectTrigger size="sm" aria-label={gt("Upstash Box snapshot")}>
            <SelectValue>{selectedLabel}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            <SelectItem value="">{gt("Fresh Box (no snapshot)")}</SelectItem>
            {value && !selected ? (
              <SelectItem value={value} disabled>
                {gt("Saved snapshot unavailable")}
              </SelectItem>
            ) : null}
            {snapshots.map((snapshot) => (
              <SelectItem
                key={snapshot.id}
                value={snapshot.id}
                disabled={snapshot.status !== "ready"}
              >
                <div className="min-w-0">
                  <div className="break-words">{snapshotName(snapshot)}</div>
                  <div className="text-xs text-muted-foreground">
                    {new Date(snapshot.createdAt * 1000).toLocaleString()}
                    {snapshot.status === "creating"
                      ? ` · ${gt("Creating…")}`
                      : snapshot.status === "error"
                        ? ` · ${gt("Failed")}`
                        : ""}
                  </div>
                </div>
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={gt("Refresh snapshots")}
          disabled={!canChoose || pending}
          onClick={() => {
            setPending(true);
            void refresh();
          }}
        >
          <RefreshCwIcon aria-hidden />
        </Button>
      </div>
      <p role="status" className="text-xs leading-5 text-muted-foreground">
        {!canChoose
          ? gt("You do not have permission to choose snapshots.")
          : error
            ? gt("Could not load snapshots. Check your Box connection, then refresh.")
            : pending
              ? gt("Loading snapshots…")
              : snapshots.length === 0
                ? gt("No snapshots yet. Snapshots saved in Box will appear here.")
                : gt("Only ready snapshots can be used for new threads.")}
      </p>
      {selected ? (
        <div className="space-y-1.5 pt-1">
          <Label htmlFor={`snapshot-name-${environmentId}`}>{gt("Snapshot name")}</Label>
          <DraftInput
            key={selected.id}
            id={`snapshot-name-${environmentId}`}
            aria-label={gt("Snapshot name")}
            disabled={!canChoose}
            value={names[selected.id] || selected.name}
            placeholder={selected.name || gt("Unnamed snapshot")}
            onCommit={(name) =>
              updateSettings({ upstashBox: { snapshotNames: { [selected.id]: name.trim() } } })
            }
          />
          <p className="text-xs leading-5 text-muted-foreground">
            {gt(
              "Display names are shared by projects on this environment. The snapshot in Box is unchanged.",
            )}
          </p>
        </div>
      ) : null}
    </div>
  );
}
