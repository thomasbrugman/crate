import { getPairingTokenFromUrl } from "@t3tools/shared/remote";

export function parsePairingCredential(value: string): string {
  const trimmed = value.trim();
  if (!URL.canParse(trimmed)) return trimmed;
  const url = new URL(trimmed);
  if (url.protocol !== "http:" && url.protocol !== "https:") return trimmed;
  return getPairingTokenFromUrl(url) ?? trimmed;
}
