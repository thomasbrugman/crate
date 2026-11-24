import { AuthProvidersManageScope, type EnvironmentId, UpstashBoxSize } from "@t3tools/contracts";
import {
  BOX_HARNESS_DRIVER_KINDS,
  BOX_HARNESS_LABELS,
} from "@t3tools/provider-upstash-box/harnesses";
import { useAtomValue } from "@effect/atom-react";
import { msg, useGT, useMessages } from "gt-react";
import { useState } from "react";
import { CheckIcon, ExternalLinkIcon } from "lucide-react";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { providersIgnoringCheckedAtAtom } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { SetupSection } from "../onboarding/SetupSection";
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
  {
    harness: "opencode",
    field: "opencodeAuth",
    label: BOX_HARNESS_LABELS.opencode,
    hint: msg("Paste the contents of ~/.local/share/opencode/auth.json after signing in."),
  },
  {
    harness: "cursor",
    field: "cursorAuth",
    label: BOX_HARNESS_LABELS.cursor,
    hint: msg("Paste your Cursor API key."),
  },
  {
    harness: "antigravity",
    field: "antigravityAuth",
    label: BOX_HARNESS_LABELS.antigravity,
    hint: msg("Paste your Gemini API key."),
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
  const [selectedHarness, setSelectedHarness] = useState<
    (typeof harnessCredentials)[number]["harness"] | null
  >(null);

  const renderHarness = ({ harness, field, label, hint }: (typeof harnessCredentials)[number]) => {
    const connected = typeof box[field] !== "string" || box[field] !== "";
    const provider = providers.find(
      (entry) => entry.enabled && entry.driver === BOX_HARNESS_DRIVER_KINDS[harness],
    );
    const credentialInput = (
      <>
        {onboarding ? (
          <OnboardingSecretInput
            key={field}
            label={label}
            configured={connected}
            disabled={readOnly}
            onSave={(credential) => update({ [field]: credential })}
          />
        ) : (
          <SecretInput
            aria-label={label}
            configured={connected}
            disabled={readOnly}
            value=""
            onCommit={(credential) => update({ [field]: credential.trim() })}
          />
        )}
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
        environmentLabel={gt("Upstash Box")}
        instanceId={provider.instanceId}
        provider={provider}
        readOnly={readOnly}
      />
    ) : (
      <SettingsRow
        key={field}
        title={label}
        description={m(hint)}
        control={<div className="flex min-w-0 flex-wrap items-center gap-2">{credentialInput}</div>}
      />
    );
  };

  if (onboarding) {
    return (
      <>
        <SetupSection
          step={1}
          title={gt("Connect Upstash Box")}
          description={gt(
            "Each thread runs in its own cloud sandbox. Add your Box API key to get started.",
          )}
        >
          <div className="space-y-3">
            <OnboardingSecretInput
              label={gt("Upstash Box API key")}
              configured={keyConfigured}
              disabled={readOnly}
              onSave={(apiKey) => update({ apiKey })}
            />
            <div className="flex min-h-7 flex-wrap items-center justify-between gap-2 text-xs">
              <a
                href="https://console.upstash.com/"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring"
              >
                {gt("Get a Box API key")}
                <ExternalLinkIcon className="size-3" />
              </a>
              {keyConfigured && !readOnly ? (
                <Button size="xs" variant="ghost-muted" onClick={() => update({ apiKey: "" })}>
                  {gt("Remove")}
                </Button>
              ) : null}
            </div>
          </div>
        </SetupSection>
        <SetupSection
          step={2}
          title={gt("Choose your coding agent")}
          description={gt("Connect one to start. You can add more later in Settings.")}
        >
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {harnessCredentials.map(({ harness, field, label }) => {
              const saved = typeof box[field] !== "string" || box[field] !== "";
              return (
                <button
                  key={harness}
                  type="button"
                  aria-pressed={selectedHarness === harness}
                  onClick={() => setSelectedHarness(harness)}
                  className="flex min-h-14 min-w-0 items-center gap-3 rounded-lg border border-border bg-background px-3 py-3 text-left text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring aria-pressed:border-foreground/50 aria-pressed:bg-accent aria-pressed:text-foreground"
                >
                  <ProviderInstanceIcon
                    driverKind={BOX_HARNESS_DRIVER_KINDS[harness]}
                    displayName={label}
                  />
                  <span className="min-w-0 flex-1 font-medium">{label}</span>
                  {saved ? (
                    <CheckIcon className="size-3.5 shrink-0" aria-label={gt("Saved")} />
                  ) : null}
                </button>
              );
            })}
          </div>
          {harnessCredentials
            .filter(({ harness }) => harness === selectedHarness)
            .map((credential) => (
              <div key={credential.field} className="mt-4 border-t border-border/60 pt-2">
                {renderHarness(credential)}
              </div>
            ))}
        </SetupSection>
      </>
    );
  }

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
                "Used to set up legacy {harness} Boxes, not to configure Git credentials.",
                { harness: BOX_HARNESS_LABELS.commandCode },
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
        {harnessCredentials.map(renderHarness)}
      </SettingsSection>
    </>
  );
}

function OnboardingSecretInput({
  label,
  configured,
  disabled,
  onSave,
}: {
  readonly label: string;
  readonly configured: boolean;
  readonly disabled: boolean;
  readonly onSave: (value: string) => void;
}) {
  const gt = useGT();
  const [draft, setDraft] = useState("");
  return (
    <div className="w-full min-w-0 space-y-2">
      <form
        className="flex min-w-0 items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (disabled || !draft.trim()) return;
          onSave(draft.trim());
          setDraft("");
        }}
      >
        <Input
          type="password"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          aria-label={label}
          disabled={disabled}
          placeholder={configured ? gt("Enter a replacement key") : gt("Paste your key or token")}
          value={draft}
          onChange={(event) => setDraft(event.currentTarget.value)}
        />
        <Button size="sm" variant="outline" type="submit" disabled={disabled || !draft.trim()}>
          {gt("Save")}
        </Button>
      </form>
      <p role="status" className="min-h-8 text-xs leading-4 text-muted-foreground">
        {configured
          ? gt("Saved securely. You can replace it at any time.")
          : gt("Your key stays private. It is never included in project snapshots.")}
      </p>
    </div>
  );
}
