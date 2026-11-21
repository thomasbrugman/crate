import { BoxExec } from "@t3tools/provider-upstash-box/server";
import * as ByteSize from "effect/ByteSize";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
// @effect-diagnostics nodeBuiltinImport:off - RPC cwd validation is synchronous and uses the Box's POSIX paths.
import * as NodePathPosix from "node:path/posix";
import * as PlatformError from "effect/PlatformError";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import * as VcsThreadTarget from "./VcsThreadTarget.ts";

export const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

class BoxGitError extends Schema.TaggedError<BoxGitError>()("BoxGitError", {
  detail: Schema.String,
}) {
  override get message() {
    return this.detail;
  }
}

const serializeRequest = (method: string, args: unknown[]) => JSON.stringify([method, args]);
const decodeResponse = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      value: Schema.optional(Schema.Unknown),
      error: Schema.optional(Schema.String),
    }),
  ),
);

export const mapPath = (
  target: VcsThreadTarget.Target,
  value: string,
  internal = false,
  temporary = false,
) => {
  const root = NodePathPosix.resolve(target.projectRoot);
  const resolved = NodePathPosix.resolve(value);
  if (
    internal &&
    (resolved === target.checkoutRoot ||
      resolved.startsWith(`${target.checkoutRoot}/`) ||
      (temporary && resolved.startsWith("/tmp/")))
  )
    return resolved;
  const relative = NodePathPosix.relative(root, resolved);
  if (relative === ".." || relative.startsWith("../") || NodePathPosix.isAbsolute(relative))
    return undefined;
  return NodePathPosix.join(target.checkoutRoot, relative);
};

export const exec = Effect.fn("BoxGitHost.exec")(function* (input: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly stdin?: string;
  readonly env?: NodeJS.ProcessEnv;
}) {
  const target = yield* VcsThreadTarget.VcsThreadTarget;
  const api = yield* Effect.serviceOption(BoxExec.BoxExec);
  const unavailable = () => new BoxGitError({ detail: "Box unavailable for Git execution." });
  if (!target || Option.isNone(api)) return yield* unavailable();
  const cwd = input.cwd === undefined ? target.checkoutRoot : mapPath(target, input.cwd, true);
  if (cwd === undefined)
    return yield* new BoxGitError({ detail: "Git path is outside the thread's project root." });
  const env = Object.entries(input.env ?? {}).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  );
  if (env.some(([key]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))) return yield* unavailable();
  const prefix = env.map(([key, value]) => `${key}=${quote(value)}`).join(" ");
  const pipe =
    input.stdin === undefined
      ? ""
      : `printf '%s' ${quote(Buffer.from(input.stdin).toString("base64"))} | base64 -d | `;
  return yield* api.value
    .run({
      threadId: target.threadId,
      command: `${pipe}${prefix ? `${prefix} ` : ""}${quote(input.command)}`,
      args: input.args,
      ...(cwd === target.checkoutRoot ? {} : { cwd }),
    })
    .pipe(Effect.mapError(unavailable));
});

// This protocol is private to Git's filesystem dependency; no filesystem RPC is exposed.
const fileScript = String.raw`
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const [method, args] = JSON.parse(process.argv[1]);
try {
  let value;
  switch (method) {
    case 'exists': value = fs.existsSync(args[0]); break;
    case 'realPath': value = fs.realpathSync(args[0]); break;
    case 'readFileString': value = fs.readFileSync(args[0], args[1] || 'utf8'); break;
    case 'readFile': value = fs.readFileSync(args[0]).toString('base64'); break;
    case 'writeFileString': fs.writeFileSync(args[0], args[1]); break;
    case 'writeFile': fs.writeFileSync(args[0], Buffer.from(args[1], 'base64')); break;
    case 'readDirectory': value = fs.readdirSync(args[0]); break;
    case 'readLink': value = fs.readlinkSync(args[0]); break;
    case 'copyFile': fs.copyFileSync(args[0], args[1]); break;
    case 'rename': fs.renameSync(args[0], args[1]); break;
    case 'link': fs.linkSync(args[0], args[1]); break;
    case 'chmod': fs.chmodSync(args[0], args[1]); break;
    case 'makeDirectory': fs.mkdirSync(args[0], args[1]); break;
    case 'remove': fs.rmSync(args[0], { recursive: args[1]?.recursive, force: args[1]?.force }); break;
    case 'utimes': fs.utimesSync(args[0], typeof args[1] === 'number' ? args[1] : new Date(args[1]), typeof args[2] === 'number' ? args[2] : new Date(args[2])); break;
    case 'makeTempDirectory':
    case 'makeTempDirectoryScoped':
    case 'makeTempFile':
    case 'makeTempFileScoped': {
      const opts = args[0] || {};
      const dir = fs.mkdtempSync(path.join(opts.directory || os.tmpdir(), opts.prefix || 't3code-git-'));
      value = method.startsWith('makeTempFile') ? path.join(dir, 'file' + (opts.suffix || '')) : dir;
      if (method.startsWith('makeTempFile')) fs.writeFileSync(value, '');
      break;
    }
    case 'stat':
    case 'lstat': {
      const s = method === 'stat' ? fs.statSync(args[0]) : fs.lstatSync(args[0]);
      value = { type: s.isFile() ? 'File' : s.isDirectory() ? 'Directory' : s.isSymbolicLink() ? 'SymbolicLink' : 'Unknown',
        size: s.size, mtime: s.mtimeMs, atime: s.atimeMs, birthtime: s.birthtimeMs,
        dev: s.dev, ino: s.ino, mode: s.mode, nlink: s.nlink, uid: s.uid, gid: s.gid, rdev: s.rdev, blksize: s.blksize, blocks: s.blocks };
      break;
    }
    default: throw Object.assign(new Error('Unsupported Git filesystem operation'), { code: 'ENOSYS' });
  }
  process.stdout.write(JSON.stringify({ value }));
} catch (e) { process.stdout.write(JSON.stringify({ error: e.code || 'EIO' })); }
`;

const fileError = (method: string, code: string) =>
  PlatformError.systemError({
    _tag: code === "ENOENT" ? "NotFound" : code === "EACCES" ? "PermissionDenied" : "Unknown",
    module: "FileSystem",
    method,
    description: "Box Git filesystem operation failed.",
  });

export const fileSystem = (host: FileSystem.FileSystem): FileSystem.FileSystem =>
  new Proxy(host, {
    get(object, key) {
      const method = String(key);
      const original: unknown = Reflect.get(object, key);
      if (typeof original !== "function") return original;
      if (method === "watch")
        return (...args: unknown[]) =>
          Stream.unwrap(
            Effect.map(VcsThreadTarget.VcsThreadTarget, (target) =>
              target
                ? Stream.empty
                : (Reflect.apply(original, object, args) as Stream.Stream<unknown>),
            ),
          );
      return (...args: unknown[]) =>
        Effect.gen(function* () {
          const target = yield* VcsThreadTarget.VcsThreadTarget;
          if (!target)
            return yield* Reflect.apply(original, object, args) as Effect.Effect<
              unknown,
              PlatformError.PlatformError,
              Scope.Scope
            >;
          const converted = [...args];
          for (const index of [
            0,
            ...(["copyFile", "rename", "link"].includes(method) ? [1] : []),
          ]) {
            const value = converted[index];
            if (typeof value === "string") {
              const mapped = mapPath(target, value, true, true);
              if (mapped === undefined) return yield* fileError(method, "EACCES");
              converted[index] = mapped;
            }
          }
          if (method === "writeFile" && converted[1] instanceof Uint8Array)
            converted[1] = Buffer.from(converted[1]).toString("base64");
          if (method.startsWith("makeTemp") && converted[0]) {
            const options = converted[0] as { directory?: string };
            if (options.directory !== undefined) {
              const directory = mapPath(target, options.directory, true, true);
              if (directory === undefined) return yield* fileError(method, "EACCES");
              converted[0] = { ...options, directory };
            }
          }
          const run = exec({
            command: "node",
            args: ["-e", fileScript, serializeRequest(method, converted)],
          }).pipe(
            Effect.mapError(() => fileError(method, "EIO")),
            Effect.flatMap((result) =>
              decodeResponse(result.stdout).pipe(Effect.mapError(() => fileError(method, "EIO"))),
            ),
            Effect.flatMap((result) =>
              result.error
                ? Effect.fail(fileError(method, result.error))
                : Effect.succeed(result.value),
            ),
          );
          const value = yield* run;
          if (method === "readFile") return new Uint8Array(Buffer.from(String(value), "base64"));
          if (method === "stat" || method === "lstat") {
            const stat = value as Record<string, number | string>;
            return {
              ...stat,
              size: ByteSize.bytes(Number(stat.size)),
              mtime: Option.some(DateTime.toDateUtc(DateTime.makeUnsafe(Number(stat.mtime)))),
              atime: Option.some(DateTime.toDateUtc(DateTime.makeUnsafe(Number(stat.atime)))),
              birthtime: Option.some(
                DateTime.toDateUtc(DateTime.makeUnsafe(Number(stat.birthtime))),
              ),
              ino: Option.some(BigInt(stat.ino!)),
              dev: BigInt(stat.dev!),
              nlink: Option.some(BigInt(stat.nlink!)),
              uid: Option.some(Number(stat.uid)),
              gid: Option.some(Number(stat.gid)),
              rdev: Option.some(BigInt(stat.rdev!)),
              blksize: Option.some(ByteSize.bytes(Number(stat.blksize))),
              blocks: Option.some(BigInt(stat.blocks!)),
            };
          }
          if (method === "makeTempDirectoryScoped" || method === "makeTempFileScoped") {
            yield* Effect.addFinalizer(() =>
              exec({
                command: "rm",
                args: [
                  "-rf",
                  "--",
                  method === "makeTempFileScoped"
                    ? NodePathPosix.dirname(String(value))
                    : String(value),
                ],
              }).pipe(
                Effect.provideService(VcsThreadTarget.VcsThreadTarget, target),
                Effect.ignore,
              ),
            );
          }
          return value;
        });
    },
  });
