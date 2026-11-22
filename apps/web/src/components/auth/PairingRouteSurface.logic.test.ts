import { expect, it } from "vite-plus/test";

import { parsePairingCredential } from "./PairingRouteSurface.logic";

it.each([
  [" token ", "token"],
  ["https://mac.example/pair#token=abc%2B123", "abc+123"],
  [" http://192.168.1.2:3773/pair?token=abc ", "abc"],
  ["", ""],
  ["   ", ""],
  ["https://mac.example/pair", "https://mac.example/pair"],
  ["http://[invalid", "http://[invalid"],
  ["ftp://mac.example/pair#token=abc", "ftp://mac.example/pair#token=abc"],
])("reads a pairing credential from %j", (input, expected) => {
  expect(parsePairingCredential(input)).toBe(expected);
});
