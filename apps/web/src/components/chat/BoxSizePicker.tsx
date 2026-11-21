import { BoxSize } from "@t3tools/contracts";
import { getProviderClient } from "@t3tools/client-runtime/provider-clients";
import * as Schema from "effect/Schema";
import { useGT, useMessages } from "gt-react";
import { BoxIcon, ChevronDownIcon } from "lucide-react";

import { type DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { ComposerContextLabel } from "../ComposerContextLabel";
import {
  deriveProviderSettingsFields,
  readProviderConfigString,
} from "../settings/ProviderSettingsForm";
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

const isBoxSize = Schema.is(BoxSize);
const upstashBoxClient = getProviderClient("upstashBox");

export function BoxSizePicker(props: {
  draftId: DraftId;
  providerConfig: unknown;
  disabled: boolean;
}) {
  const gt = useGT();
  const m = useMessages();
  const menuProps = useComposerMenuProps();
  const boxSize = useComposerDraftStore((store) => store.getComposerDraft(props.draftId)?.boxSize);
  const sizeField =
    upstashBoxClient &&
    deriveProviderSettingsFields(upstashBoxClient, undefined, m).find(({ key }) => key === "size");
  const options = sizeField?.options;
  if (!options) return null;
  const size = boxSize ?? readProviderConfigString(props.providerConfig, "size");
  const sizeLabel =
    options.find((option) => option.value === size)?.label ??
    sizeField.placeholder ??
    sizeField.label;
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
        <ComposerContextLabel>{sizeLabel}</ComposerContextLabel>
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
              {gt("Provider default")}
              <MenuRadioItemIndicator />
            </span>
          </MenuRadioItem>
          {options.map(({ value, label }) => (
            <MenuRadioItem key={value} value={value} closeOnClick>
              <span className="flex items-center justify-between gap-3">
                {label}
                <MenuRadioItemIndicator />
              </span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}
