import { type EnvironmentId, UpstashBoxSize } from "@t3tools/contracts";
import { msg, useGT, useMessages } from "gt-react";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SecretInput } from "./SecretInput";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export const UPSTASH_BOX_SIZE_LABELS = {
  small: msg("Small"),
  medium: msg("Medium"),
  large: msg("Large"),
} satisfies Record<UpstashBoxSize, string>;

/** Where every thread on this environment runs; providers pick the agent inside it. */
export function UpstashBoxEnvironmentSettings({
  environmentId,
  readOnly = false,
}: {
  readonly environmentId: EnvironmentId;
  readonly readOnly?: boolean;
}) {
  const gt = useGT();
  const m = useMessages();
  const box = useEnvironmentSettings(environmentId, (settings) => settings.upstashBox);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const keyConfigured = typeof box.apiKey !== "string" || box.apiKey !== "";
  const update = (patch: Partial<typeof box>) => updateSettings({ upstashBox: patch });

  return (
    <SettingsSection title={gt("Upstash Box environment")}>
      <SettingsRow
        title={gt("API key")}
        description={gt("Each thread gets its own Box. Falls back to UPSTASH_BOX_API_KEY.")}
        control={
          <div className="flex items-center gap-2">
            <SecretInput
              aria-label={gt("Upstash Box API key")}
              configured={keyConfigured}
              disabled={readOnly}
              value=""
              onCommit={(apiKey) => update({ apiKey })}
            />
            {keyConfigured && !readOnly ? (
              <Button size="sm" variant="outline" onClick={() => update({ apiKey: "" })}>
                {gt("Remove")}
              </Button>
            ) : null}
          </div>
        }
      />
      <SettingsRow
        title={gt("Template Box")}
        description={gt("New Boxes copy Git credentials and the Command Code login from this Box.")}
        control={
          <DraftInput
            aria-label={gt("Template Box")}
            autoCapitalize="none"
            spellCheck={false}
            disabled={readOnly}
            value={box.templateBoxName}
            onCommit={(templateBoxName) => update({ templateBoxName: templateBoxName.trim() })}
          />
        }
      />
      <SettingsRow
        title={gt("Box size")}
        description={gt("Applies to Boxes created for new threads.")}
        control={
          <Select
            value={box.size}
            disabled={readOnly}
            onValueChange={(value) => {
              if (UpstashBoxSize.literals.includes(value as UpstashBoxSize))
                update({ size: value as UpstashBoxSize });
            }}
          >
            <SelectTrigger size="sm" aria-label={gt("Box size")}>
              <SelectValue>
                {(value: UpstashBoxSize) => m(UPSTASH_BOX_SIZE_LABELS[value])}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {UpstashBoxSize.literals.map((size) => (
                <SelectItem key={size} value={size}>
                  {m(UPSTASH_BOX_SIZE_LABELS[size])}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
    </SettingsSection>
  );
}
