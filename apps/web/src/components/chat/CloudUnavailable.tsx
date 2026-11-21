import { T } from "gt-react";

export function CloudUnavailable() {
  return (
    <div
      role="status"
      className="flex min-h-32 flex-1 items-center justify-center border-t p-6 text-center text-sm text-muted-foreground"
    >
      <T>Not available in cloud threads. Ask the agent to use its Box tools.</T>
    </div>
  );
}
