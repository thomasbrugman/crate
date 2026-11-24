import {
  BoxComposerCapabilitiesError,
  type BoxComposerCapabilities,
  type BoxComposerCapabilitiesInput,
  ProjectSearchEntriesError,
  ProjectSearchEntriesResult,
  type ProjectSearchEntriesInput,
  type ThreadId,
} from "@t3tools/contracts";
import {
  BOX_COMMAND_CODE_HOME,
  BOX_CREDENTIALS_DIR,
  BoxApi,
  BoxExec,
} from "@t3tools/provider-upstash-box/server";
import { SKILL_MENTION_PATTERN } from "@t3tools/shared/composerInlineTokens";
import { normalizeSearchQuery, scoreSubsequenceMatch } from "@t3tools/shared/searchRanking";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { parseSkillFrontmatter } from "../provider/Drivers/ClaudeSkills.ts";

const searchCommand = String.raw`
const { spawnSync } = require("node:child_process");
const { existsSync, lstatSync } = require("node:fs");
const { basename, dirname } = require("node:path");
const [query, limitText, kind, imageOnly] = process.argv.slice(1);
const limit = Number(limitText);
const internal = [".git", ".crate-worktrees", ".crate-attachments", "node_modules"];
const scratch = process.cwd() === "/workspace/home";
const ignored = scratch ? [
  ".git", ".box", ".box-internal", ".claude", ".codex", ".cursor", ".local",
  ".crate-worktrees", ".crate-attachments", "node_modules",
] : internal;
const git = existsSync(".git");
const result = spawnSync(git ? "git" : "find", git
  ? ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]
  : ["-P", ".", "(", ...ignored.flatMap((name, index) =>
      [...(index > 0 ? ["-o"] : []), "-name", name]),
     ...(scratch ? ["-o", "-path", "./.*"] : []),
     ")", "-prune", "-o", "(", "-type", "f", "-o", "-type", "d", ")", "-print0"],
  { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 5000 });
if (result.status !== 0) process.exit(1);
const scoreSubsequence = (${scoreSubsequenceMatch.toString()});
const entries = new Map();
function add(path, entryKind) {
  if (entries.has(path) || (kind && kind !== entryKind)) return;
  if (imageOnly && (entryKind !== "file" || !/\.(?:avif|bmp|gif|ico|jpe?g|png|svg|webp)$/iu.test(path))) return;
  const score = scoreSubsequence(path.toLowerCase(), query);
  if (score === null) return;
  const nameScore = scoreSubsequence(basename(path).toLowerCase(), query);
  entries.set(path, { path, kind: entryKind, score: nameScore === null ? score + 100 : nameScore });
}
for (const rawPath of result.stdout.split("\0")) {
  const path = rawPath.replace(/^\.\//u, "");
  if (!path || path === "." || path !== path.trim() || /[\u0000-\u001f\u007f]/u.test(path)) continue;
  if (path.split("/").some((segment) => ignored.includes(segment))) continue;
  let stat;
  try { stat = lstatSync(path); } catch { continue; }
  if (stat.isFile()) add(path, "file");
  else if (stat.isDirectory()) add(path, "directory");
  else continue;
  if (git) for (let parent = dirname(path); parent !== "."; parent = dirname(parent)) add(parent, "directory");
}
const ranked = [...entries.values()].sort((a, b) => a.score - b.score || a.path.localeCompare(b.path));
console.log(JSON.stringify({
  entries: ranked.slice(0, limit).map(({ path, kind }) => ({ path, kind })),
  truncated: ranked.length > limit,
}));
`;

const decodeResult = Schema.decodeUnknownEffect(Schema.fromJsonString(ProjectSearchEntriesResult));

export const search = Effect.fn("BoxWorkspaceEntries.search")(function* (
  input: ProjectSearchEntriesInput & { readonly boxThreadId: ThreadId },
): Effect.fn.Return<ProjectSearchEntriesResult, ProjectSearchEntriesError, BoxExec.BoxExec> {
  const box = yield* BoxExec.BoxExec;
  return yield* box
    .run({
      threadId: input.boxThreadId,
      command: "node -e",
      args: [
        searchCommand,
        "--",
        normalizeSearchQuery(input.query, { trimLeadingPattern: /^[@./]+/u }),
        String(input.limit),
        input.kind ?? "",
        input.imageOnly ? "1" : "",
      ],
    })
    .pipe(
      Effect.flatMap(
        Effect.fnUntraced(function* ({ exitCode, stdout }) {
          if (exitCode !== 0) return yield* Effect.fail("search failed");
          return yield* decodeResult(stdout);
        }),
      ),
      Effect.timeout("10 seconds"),
      Effect.catchTags({
        BoxExecError: (error) =>
          error.reason === "thread_unavailable"
            ? Effect.succeed({ entries: [], truncated: false })
            : Effect.fail(error),
      }),
      Effect.mapError(
        (cause) =>
          new ProjectSearchEntriesError({
            cwd: input.cwd,
            queryLength: input.query.length,
            limit: input.limit,
            failure: "search_index_search_failed",
            detail: "Could not search this thread’s Box files.",
            cause,
          }),
      ),
    );
});

const discoverCommand = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const roots = JSON.parse(process.argv[1]);
const harness = process.argv[2];
const entries = [];
const maxEntries = 100;
const maxBytes = 4096;
const deadline = Date.now() + 4000;
function scan(root, directory, depth = 0) {
  if (depth > 8 || entries.length >= maxEntries || Date.now() >= deadline) return;
  try {
    if (fs.realpathSync(directory) !== directory) return;
    for (const item of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entries.length >= maxEntries || Date.now() >= deadline) break;
      if (item.name.startsWith(".")) continue;
      const file = path.join(directory, item.name);
      if (item.isDirectory()) scan(root, file, depth + 1);
      if (!item.isFile() || (root.kind === "skill" ? item.name !== "SKILL.md" : !item.name.endsWith(".md"))) continue;
      const filename = path.relative(root.directory, file);
      const name = root.kind === "skill"
        ? path.basename(directory)
        : harness === "commandCode" ? path.basename(file, ".md") : filename.slice(0, -3).replaceAll("/", ":");
      if (!name || name.length > 128 || file.length > 1024) continue;
      let fd;
      try {
        fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        if (!fs.fstatSync(fd).isFile()) continue;
        const buf = Buffer.alloc(maxBytes);
        const contents = buf.toString("utf8", 0, fs.readSync(fd, buf, 0, maxBytes, 0));
        const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(contents);
        const frontmatter = match?.[0] ?? "";
        const description = root.kind === "command" && harness === "commandCode"
          ? contents.slice(frontmatter.length).split(/\r?\n/u).map((line) => line.replace(/^\s*#+\s+/u, "").trim()).find(Boolean)?.slice(0, 80)
          : undefined;
        entries.push({ kind: root.kind, scope: root.scope, name, path: file, frontmatter, description });
      } catch {} finally {
        if (fd !== undefined) fs.closeSync(fd);
      }
    }
  } catch {}
}
for (const root of roots) {
  root.directory = path.resolve(root.directory);
  scan(root, root.directory);
}
console.log(JSON.stringify(entries));
`;

const decodeDiscovery = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        kind: Schema.Literals(["skill", "command"]),
        scope: Schema.Literals(["project", "user"]),
        name: Schema.String,
        path: Schema.String,
        frontmatter: Schema.String,
        description: Schema.optional(Schema.String),
      }),
    ),
  ),
);

const rootsByHarness = {
  commandCode: {
    project: {
      skills: [".commandcode/skills", ".agents/skills"],
      commands: [".commandcode/commands"],
    },
    user: {
      skills: [
        `${BOX_COMMAND_CODE_HOME}/.commandcode/skills`,
        `${BOX_COMMAND_CODE_HOME}/.agents/skills`,
      ],
      commands: [`${BOX_COMMAND_CODE_HOME}/.commandcode/commands`],
    },
  },
  claudeCode: {
    project: { skills: [".claude/skills"], commands: [".claude/commands"] },
    user: {
      skills: [`${BOX_CREDENTIALS_DIR}/claude/skills`],
      commands: [`${BOX_CREDENTIALS_DIR}/claude/commands`],
    },
  },
  codex: {
    project: { skills: [".agents/skills"], commands: [] },
    user: {
      skills: [`${BoxApi.BOX_HOME}/.agents/skills`, `${BOX_CREDENTIALS_DIR}/codex/skills`],
      commands: [],
    },
  },
};

function discoveryRoots(harness: BoxComposerCapabilitiesInput["harness"]) {
  const { project, user } = rootsByHarness[harness];
  return JSON.stringify([
    ...project.skills.map((directory) => ({ kind: "skill", scope: "project", directory })),
    ...user.skills.map((directory) => ({ kind: "skill", scope: "user", directory })),
    // Command Code dispatches user commands before project commands, unlike skills.
    ...(harness === "commandCode"
      ? (["user", "project"] as const)
      : (["project", "user"] as const)
    ).flatMap((scope) =>
      rootsByHarness[harness][scope].commands.map((directory) => ({
        kind: "command",
        scope,
        directory,
      })),
    ),
  ]);
}

export const discover = Effect.fn("BoxWorkspaceEntries.discover")(function* (
  input: BoxComposerCapabilitiesInput,
): Effect.fn.Return<BoxComposerCapabilities, BoxComposerCapabilitiesError, BoxExec.BoxExec> {
  const box = yield* BoxExec.BoxExec;
  return yield* box
    .run({
      threadId: input.threadId,
      command: "node -e",
      args: [discoverCommand, "--", discoveryRoots(input.harness), input.harness],
    })
    .pipe(
      Effect.flatMap(
        Effect.fnUntraced(function* ({ exitCode, stdout }) {
          if (exitCode !== 0) return yield* Effect.fail("discovery failed");
          return yield* decodeDiscovery(stdout);
        }),
      ),
      Effect.map((entries) => {
        const skills = new Map<string, BoxComposerCapabilities["skills"][number]>();
        const slashCommands = new Map<string, BoxComposerCapabilities["slashCommands"][number]>();
        for (const entry of entries) {
          const metadata = parseSkillFrontmatter(entry.frontmatter);
          const parsed = metadata.kind === "parsed" ? metadata : undefined;
          const description = (entry.description ?? parsed?.description)?.slice(0, 300).trim();
          if (entry.kind === "command") {
            if (!/^[\w.-]+(?::[\w.-]+)*$/u.test(entry.name) || slashCommands.has(entry.name))
              continue;
            slashCommands.set(entry.name, {
              name: entry.name,
              ...(description ? { description } : {}),
            });
          } else {
            const name = parsed?.name ?? entry.name;
            if (
              Array.from(`$${name}`.matchAll(SKILL_MENTION_PATTERN))[0]?.[0] !== `$${name}` ||
              skills.has(name)
            )
              continue;
            skills.set(name, {
              name,
              path: entry.path,
              scope: entry.scope,
              enabled: true,
              ...(description ? { description } : {}),
              ...(parsed?.userInvocationOnly ? { userInvocationOnly: true } : {}),
              ...(parsed?.userInvocable === false ? { userInvocable: false } : {}),
            });
          }
        }
        return { skills: [...skills.values()], slashCommands: [...slashCommands.values()] };
      }),
      Effect.timeout("10 seconds"),
      Effect.catchTags({
        BoxExecError: (error) =>
          error.reason === "thread_unavailable"
            ? Effect.succeed({ skills: [], slashCommands: [] })
            : Effect.fail(error),
      }),
      Effect.mapError(
        () =>
          new BoxComposerCapabilitiesError({
            message: "Could not discover this Box’s commands and skills.",
          }),
      ),
    );
});
