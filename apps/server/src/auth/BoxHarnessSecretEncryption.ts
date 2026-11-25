// @effect-diagnostics-next-line nodeBuiltinImport:off - AES-GCM needs Node's authenticated cipher API.
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  SecretStoreDecodeError,
  SecretStoreEncodeError,
  type ServerSecretStore,
} from "./ServerSecretStore.ts";

const keyName = "upstash-box-harness-encryption-key";
const encryptedNames = [
  "commandCodeAuth",
  "claudeCodeAuth",
  "codexAuth",
  "opencodeAuth",
  "cursorAuth",
  "antigravityAuth",
  "grokAuth",
  "kiroAuth",
  "museAuth",
].map((field) => `upstash-box-${Buffer.from(field).toString("base64url")}`);
const isHarnessSecret = (name: string) =>
  encryptedNames.some((prefix) => name === prefix || name.startsWith(`${prefix}-`));

export function encryptBoxHarnessSecrets(store: ServerSecretStore["Service"]): typeof store {
  const key = store.getOrCreateRandom(keyName, 32);
  return {
    ...store,
    set: (name, value) =>
      !isHarnessSecret(name)
        ? store.set(name, value)
        : key.pipe(
            Effect.flatMap((bytes) =>
              Effect.try({
                try: () => {
                  const nonce = NodeCrypto.randomBytes(12);
                  const cipher = NodeCrypto.createCipheriv("aes-256-gcm", bytes, nonce);
                  cipher.setAAD(Buffer.from(name));
                  const content = Buffer.concat([cipher.update(value), cipher.final()]);
                  return Buffer.concat([nonce, cipher.getAuthTag(), content]);
                },
                catch: (cause) => new SecretStoreEncodeError({ resource: name, cause }),
              }),
            ),
            Effect.flatMap((encrypted) => store.set(name, encrypted)),
          ),
    get: (name) =>
      !isHarnessSecret(name)
        ? store.get(name)
        : store.get(name).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.succeedNone,
                onSome: (encrypted) =>
                  key.pipe(
                    Effect.flatMap((bytes) =>
                      Effect.try({
                        try: () => {
                          const decipher = NodeCrypto.createDecipheriv(
                            "aes-256-gcm",
                            bytes,
                            encrypted.subarray(0, 12),
                          );
                          decipher.setAAD(Buffer.from(name));
                          decipher.setAuthTag(encrypted.subarray(12, 28));
                          return Option.some(
                            Buffer.concat([
                              decipher.update(encrypted.subarray(28)),
                              decipher.final(),
                            ]),
                          );
                        },
                        catch: (cause) => new SecretStoreDecodeError({ resource: name, cause }),
                      }),
                    ),
                  ),
              }),
            ),
          ),
  };
}
