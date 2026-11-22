import type { ReactNode } from "react";

export function SetupSection({
  title,
  description,
  step,
  children,
}: {
  readonly title: string;
  readonly description?: string;
  readonly step?: number | undefined;
  readonly children: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-border/70 bg-card/40 p-4 sm:p-5">
      <div className="mb-4 flex items-start gap-3">
        {step === undefined ? null : (
          <span
            aria-hidden
            className="flex size-6 shrink-0 items-center justify-center rounded-full border border-border text-xs font-medium text-muted-foreground"
          >
            {step}
          </span>
        )}
        <div className="min-w-0">
          <h2 className="text-sm leading-6 font-medium text-foreground">{title}</h2>
          {description ? (
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{description}</p>
          ) : null}
        </div>
      </div>
      {children}
    </section>
  );
}
