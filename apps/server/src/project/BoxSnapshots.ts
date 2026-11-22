import { BoxSnapshotsError, isSecretReference } from "@t3tools/contracts";
import type { BoxSnapshotList } from "@t3tools/contracts";
import { BoxApi } from "@t3tools/provider-upstash-box/server";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ServerSettings from "../serverSettings.ts";

const SnapshotResponse = Schema.Struct({
  snapshots: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      status: Schema.Literals(["creating", "ready", "error", "deleted"]),
      created_at: Schema.Number,
    }),
  ),
});
const decodeSnapshots = Schema.decodeUnknownEffect(SnapshotResponse);
const isBoxSnapshotsError = Schema.is(BoxSnapshotsError);

export class BoxSnapshots extends Context.Service<
  BoxSnapshots,
  {
    readonly list: Effect.Effect<typeof BoxSnapshotList.Type, BoxSnapshotsError>;
  }
>()("t3/project/BoxSnapshots") {}

const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const secrets = yield* SecretResolver.SecretResolver;
  const api = yield* BoxApi.BoxApi;
  const list = Effect.fn("BoxSnapshots.list")(function* () {
    const configured = (yield* settings.getSettings).upstashBox.apiKey;
    const savedKey = isSecretReference(configured)
      ? ((yield* secrets.read([configured]))[0] ?? "")
      : configured;
    const apiKey =
      savedKey || (yield* Config.String("UPSTASH_BOX_API_KEY").pipe(Config.withDefault("")));
    if (!apiKey) return yield* new BoxSnapshotsError({ reason: "not-configured" });
    const response = yield* Effect.tryPromise({
      try: () =>
        api.listSnapshots ? api.listSnapshots(apiKey) : Promise.reject(new Error("Unavailable")),
      // SDK and transport failures can carry credentials; never attach their cause.
      catch: () => new BoxSnapshotsError({ reason: "unavailable" }),
    });
    const { snapshots } = yield* decodeSnapshots(response).pipe(
      Effect.mapError(() => new BoxSnapshotsError({ reason: "unavailable" })),
    );
    return {
      snapshots: snapshots
        .flatMap((snapshot) =>
          snapshot.status === "deleted"
            ? []
            : [
                {
                  id: snapshot.id,
                  name: snapshot.name,
                  status: snapshot.status,
                  createdAt: snapshot.created_at,
                },
              ],
        )
        .sort((a, b) => b.createdAt - a.createdAt),
    };
  });
  return BoxSnapshots.of({
    list: list().pipe(
      Effect.mapError((error) =>
        isBoxSnapshotsError(error) ? error : new BoxSnapshotsError({ reason: "unavailable" }),
      ),
    ),
  });
});

export const layer = Layer.effect(BoxSnapshots, make);
