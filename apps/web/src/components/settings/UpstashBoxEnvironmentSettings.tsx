import { AuthProvidersManageScope, type EnvironmentId, UpstashBoxSize } from "@t3tools/contracts";
import {
  BOX_HARNESS_DRIVER_KINDS,
  BOX_HARNESS_LABELS,
} from "@t3tools/provider-upstash-box/harnesses";
import { useAtomValue } from "@effect/atom-react";
import { msg, useGT, useMessages } from "gt-react";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { providersIgnoringCheckedAtAtom } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SecretInput } from "./SecretInput";
import { ProviderAuthenticationSection } from "./ProviderAuthenticationSection";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const harnessCredentials = [
  {
    harness: "commandCode",
    field: "commandCodeAuth",
    label: BOX_HARNESS_LABELS.commandCode,
    hint: msg("Paste a Command Code API key or the contents of ~/.commandcode/auth.json."),
  },
  {
    harness: "claudeCode",
    field: "claudeCodeAuth",
    label: BOX_HARNESS_LABELS.claudeCode,
    hint: msg("Paste an Anthropic API key or a token from claude setup-token."),
  },
  {
    harness: "codex",
    field: "codexAuth",
    label: BOX_HARNESS_LABELS.codex,
    hint: msg("Paste an OpenAI API key or the contents of ~/.codex/auth.json after signing in."),
  },
] as const;

export const UPSTASH_BOX_SIZE_LABELS = {
  small: msg("Small"),
  medium: msg("Medium"),
  large: msg("Large"),
} satisfies Record<UpstashBoxSize, string>;

/** Where every thread on this environment runs; providers pick the agent inside it. */
export function UpstashBoxEnvironmentSettings({
  environmentId,
  readOnly = false,
  onboarding = false,
}: {
  readonly environmentId: EnvironmentId;
  readonly readOnly?: boolean;
  readonly onboarding?: boolean;
}) {
  const gt = useGT();
  const m = useMessages();
  const box = useEnvironmentSettings(environmentId, (settings) => settings.upstashBox);
  const providers = useAtomValue(providersIgnoringCheckedAtAtom(environmentId));
  const canSignIn = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const keyConfigured = typeof box.apiKey !== "string" || box.apiKey !== "";
  const update = (patch: Partial<typeof box>) => updateSettings({ upstashBox: patch });

  return (
    <>
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
        {onboarding ? null : (
          <>
            <SettingsRow
              title={gt("Template Box")}
              description={gt(
                "New Boxes copy Git configuration from this Box, not harness logins.",
              )}
              control={
                <DraftInput
                  aria-label={gt("Template Box")}
                  autoCapitalize="none"
                  spellCheck={false}
                  disabled={readOnly}
                  value={box.templateBoxName}
                  onCommit={(templateBoxName) =>
                    update({ templateBoxName: templateBoxName.trim() })
                  }
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
          </>
        )}
      </SettingsSection>
      <SettingsSection title={gt("Connect your harnesses")}>
        {harnessCredentials.map(({ harness, field, label, hint }) => {
          const connected = typeof box[field] !== "string" || box[field] !== "";
          const provider = providers.find(
            (entry) => entry.enabled && entry.driver === BOX_HARNESS_DRIVER_KINDS[harness],
          );
          const credentialInput = (
            <>
              <SecretInput
                aria-label={label}
                configured={connected}
                disabled={readOnly}
                value=""
                onCommit={(credential) => update({ [field]: credential.trim() })}
              />
              {connected &&
              !readOnly &&
              !(
                canSignIn &&
                provider?.setup?.canAuthenticate &&
                provider.auth.status === "authenticated"
              ) ? (
                <Button size="sm" variant="outline" onClick={() => update({ [field]: "" })}>
                  {gt("Disconnect")}
                </Button>
              ) : null}
            </>
          );
          return provider?.setup?.canAuthenticate && canSignIn ? (
            <ProviderAuthenticationSection
              key={field}
              title={label}
              hint={m(hint)}
              credentialInput={credentialInput}
              environmentId={environmentId}
              environmentLabel={gt("Upstash Box environment")}
              instanceId={provider.instanceId}
              provider={provider}
              readOnly={readOnly}
            />
          ) : (
            <SettingsRow
              key={field}
              title={label}
              description={m(hint)}
              control={<div className="flex flex-wrap items-center gap-2">{credentialInput}</div>}
            />
          );
        })}
      </SettingsSection>
    </>
  );
}
