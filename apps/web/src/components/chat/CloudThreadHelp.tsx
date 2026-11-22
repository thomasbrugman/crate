import { T, useGT } from "gt-react";
import { BoxIcon } from "lucide-react";

import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ComposerControl, ComposerControlIcon } from "./ComposerControl";

export function CloudThreadHelp() {
  const gt = useGT();
  return (
    <Popover>
      <PopoverTrigger render={<ComposerControl aria-label={gt("Box workspace details")} />}>
        <ComposerControlIcon icon={BoxIcon} />
      </PopoverTrigger>
      <PopoverPopup side="top" align="start" width="sm" padding="compact">
        <p className="text-sm leading-relaxed text-muted-foreground">
          <T>
            Attachments and file previews are not available in cloud threads. File mentions use the
            server checkout; only pushed files are available in the Box.
          </T>
        </p>
      </PopoverPopup>
    </Popover>
  );
}
