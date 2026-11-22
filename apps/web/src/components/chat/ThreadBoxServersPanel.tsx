import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import {
  AuthPreviewOperateScope,
  type BoxDevServer,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { GlobeIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { m } from "~/i18n/messages";
import { readLocalApi } from "../../localApi";
import { previewEnvironment } from "../../state/preview";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { THREAD_DETAILS_PANEL_ICON_CLASS } from "./threadDetailsPanelStyles";

const REFRESH_INTERVAL_MS = 15_000;

interface ThreadBoxServersPanelProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

/** The URL with its password, so one click opens the protected preview. */
function boxServerOpenUrl(server: BoxDevServer): string | null {
  if (server.url === null) return null;
  const url = new URL(server.url);
  if (server.auth) {
    url.username = server.auth.username;
    url.password = server.auth.password;
  }
  return url.toString();
}

/** Servers running inside the thread's Box. Hidden while none run. */
export function ThreadBoxServersPanel(props: ThreadBoxServersPanelProps) {
  const canList = useEnvironmentScope(props.environmentId, AuthPreviewOperateScope);
  return canList ? (
    <ThreadBoxServersList key={`${props.environmentId}:${props.threadId}`} {...props} />
  ) : null;
}

function ThreadBoxServersList(props: ThreadBoxServersPanelProps) {
  const gt = useGT();
  const listServers = useAtomCommand(previewEnvironment.listBoxServers, {
    label: "thread box servers",
    reportFailure: false,
  });
  const [servers, setServers] = useState<ReadonlyArray<BoxDevServer>>([]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polls the Box while mounted, so its server list stays in step.
  useEffect(() => {
    const controller = new AbortController();
    const refresh = async () => {
      const result = await listServers(
        { environmentId: props.environmentId, input: { threadId: props.threadId } },
        { signal: controller.signal },
      );
      if (result._tag === "Success") setServers(result.value.servers);
      else if (!isAtomCommandInterrupted(result)) setServers([]);
    };
    void refresh();
    // Each scan runs inside the Box, so it only polls while the panel is visible.
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, REFRESH_INTERVAL_MS);
    return () => {
      controller.abort();
      window.clearInterval(interval);
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- listServers is a new function each render; only the thread restarts polling.
  }, [props.environmentId, props.threadId]);

  if (servers.length === 0) return null;

  const open = (server: BoxDevServer) => {
    const url = boxServerOpenUrl(server);
    if (url === null) return;
    void readLocalApi()
      ?.shell.openExternal(url)
      .catch((error: unknown) =>
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: gt("Unable to open in browser"),
            description: thrownErrorMessage(error, m) ?? String(error),
          }),
        ),
      );
  };

  return (
    <ThreadDetailsSection
      headingId="thread-details-servers-heading"
      title={gt("Servers", { $context: "thread details section: running dev servers" })}
    >
      <ul className="m-0 list-none p-0">
        {servers.map((server) => (
          <li key={server.port} className="group relative flex items-center rounded-lg">
            <Tooltip>
              <TooltipTrigger
                delay={200}
                render={
                  <ThreadDetailsControl
                    size="sm"
                    variant="ghost"
                    part="row"
                    multiline
                    aria-disabled={server.url === null || undefined}
                    onClick={() => open(server)}
                  />
                }
              >
                <GlobeIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-sm font-medium leading-4 text-foreground/85">
                    {`:${server.port}`}
                  </span>
                  <span className="truncate text-2xs font-normal leading-4 text-muted-foreground">
                    {[
                      server.url === null
                        ? gt("Localhost only", {
                            $context: "a dev server in a Box that only listens on loopback",
                          })
                        : null,
                      server.processName,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </span>
              </TooltipTrigger>
              <TooltipPopup side="left">
                {server.url === null ? (
                  <T>Listen on 0.0.0.0 to open this server from outside the Box</T>
                ) : (
                  <T>Open in your browser with its password. It restarts when the Box wakes.</T>
                )}
              </TooltipPopup>
            </Tooltip>
          </li>
        ))}
      </ul>
    </ThreadDetailsSection>
  );
}
