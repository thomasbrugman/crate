import { UpstashBoxSize } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useGT, useMessages } from "gt-react";
import { BoxIcon, ChevronDownIcon } from "lucide-react";

import { type DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { ComposerContextLabel } from "../ComposerContextLabel";
import { UPSTASH_BOX_SIZE_LABELS } from "../settings/UpstashBoxEnvironmentSettings";
import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuTrigger,
} from "../ui/menu";
import { ComposerControl, ComposerControlIcon } from "./ComposerControl";
import { useComposerMenuProps } from "./composerEventScope";

const isBoxSize = Schema.is(UpstashBoxSize);

export function BoxSizePicker(props: {
  draftId: DraftId;
  defaultSize: UpstashBoxSize;
  disabled: boolean;
}) {
  const gt = useGT();
  const m = useMessages();
  const menuProps = useComposerMenuProps();
  const boxSize = useComposerDraftStore((store) => store.getComposerDraft(props.draftId)?.boxSize);
  const sizeLabel = m(UPSTASH_BOX_SIZE_LABELS[boxSize ?? props.defaultSize]);
  return (
    <Menu>
      <MenuTrigger
        disabled={props.disabled}
        render={
          <ComposerControl
            size="xs"
            data-composer-context-control
            aria-label={gt("Box size: {size}", { size: sizeLabel })}
          />
        }
      >
        <ComposerControlIcon icon={BoxIcon} size="xs" />
        <ComposerContextLabel>{gt("Box: {size}", { size: sizeLabel })}</ComposerContextLabel>
        <ChevronDownIcon aria-hidden="true" className="size-3" data-composer-control-chevron />
      </MenuTrigger>
      <MenuPopup side="top" align="start" {...menuProps}>
        <MenuRadioGroup
          value={boxSize ?? "default"}
          onValueChange={(value) =>
            useComposerDraftStore
              .getState()
              .setBoxSize(props.draftId, isBoxSize(value) ? value : undefined)
          }
        >
          <MenuRadioItem value="default" closeOnClick>
            <span className="flex items-center justify-between gap-3">
              {gt("Use default ({size})", { size: m(UPSTASH_BOX_SIZE_LABELS[props.defaultSize]) })}
              <MenuRadioItemIndicator />
            </span>
          </MenuRadioItem>
          {UpstashBoxSize.literals.map((size) => (
            <MenuRadioItem key={size} value={size} closeOnClick>
              <span className="flex items-center justify-between gap-3">
                {m(UPSTASH_BOX_SIZE_LABELS[size])}
                <MenuRadioItemIndicator />
              </span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}
