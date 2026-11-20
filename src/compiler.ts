import { promises as fs } from "node:fs";
import path from "node:path";
import OpenAI from "openai";
import { diffMds, hasChanges } from "./diff.js";
import { Sandbox } from "./sandbox.js";
import { OUT_DIR, STAGING_DIR, STATE_DIR, hash, loadSnapshot, readMds, readTree, saveSnapshot } from "./snapshot.js";

export const PROMPT_VERSION = 2;

const SYSTEM = `You are the compiler of "prose": a build system where markdown files are the source code.
Your job: make /work (the project's out/ directory) implement what the markdown specs describe.

You have a disposable Docker container where you are root, with network access. You can install anything (apt, npm, pip, ...), generate code, build and test. You only have two tools: bash and finish.

Layout inside the container:
- /specs   (read-only) all markdown specs, same paths as in the project
- /prose   (read-only) diff.patch = md changes since the last build; hand-edited.txt = files in /work edited by hand since the last build (may be absent)
- /state   notes.md = your own notes from the previous build (read and rewrite it)
- /work    the output. It starts as a copy of the current out/. When you call finish, /work BECOMES out/: new and changed files are written, files missing from /work are deleted. Build artifacts and dependency directories you leave there will be copied too, so clean them up before finishing.

Rules:
- The markdown files are the only source of truth. Never edit them.
- Specs contain no signatures or interfaces; you design those and keep them consistent.
- The target language(s), frameworks and layout come from the specs (stated in prose in any md file). If none is stated, pick a sensible default and record it in the notes.
- Work incrementally: start from the diff and the existing /work contents. Change only what the diff requires; create, update or delete files as needed. If the target language changes, remove the old outputs.
- Files listed in hand-edited.txt were edited by hand; preserve their intent unless the specs contradict them.
- Include whatever the specs imply (tests, build files, a README for the output) in /work.
- Build and run the tests you wrote and fix failures before finishing.
- If the specs are contradictory or too ambiguous to implement without guessing something important, call finish with error set to a short explanation of what the author must fix. Nothing is applied then. Resolve minor ambiguity yourself and mention the assumption in the notes.
- Before finishing, rewrite /state/notes.md in full: structure, key decisions, assumptions, which spec maps to which files, anything pending. It is for your future self.
- Nothing is applied until you call finish.`;

const tools: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "bash",
      description: "Run a bash command as root in the container (cwd /work). Installed packages and files persist between calls.",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    },
  },
  {
    type: "function",
    function: {
      name: "finish",
      description: "End the build. Without `error`, /work is applied to out/. With `error`, nothing is applied and the build fails.",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", description: "What was built or changed." },
          error: { type: "string", description: "Set only if the build cannot proceed; explain what the author must fix." },
        },
        required: ["summary"],
      },
    },
  },
];

export interface BuildOptions {
  root: string;
  model: string;
  apiKey: string;
  baseURL: string;
  image: string;
  maxTurns?: number;
  dry?: boolean;
  log?: (s: string) => void;
}

export type BuildResult =
  | { status: "unchanged" }
  | { status: "failed"; reason: string }
  | { status: "built"; summary: string; written: string[]; deleted: string[] };

export async function build(o: BuildOptions): Promise<BuildResult> {
  const log = o.log ?? (() => {});
  await recover(o.root);
  const snap = await loadSnapshot(o.root);
  const mds = await readMds(o.root);
  const changes = diffMds(snap.mds, mds);
  if (!hasChanges(changes)) return { status: "unchanged" };

  const outBase = path.join(o.root, OUT_DIR);
  const current = await readTree(outBase);
  const handEdited = Object.entries(current)
    .filter(([f, v]) => snap.outputs[f] !== undefined && snap.outputs[f] !== hash(v.data))
    .map(([f]) => f);

  const sb = await Sandbox.create();
  try {
    // prepare the container's view
    await fs.mkdir(outBase, { recursive: true });
    await fs.cp(outBase, sb.work, { recursive: true });
    for (const [f, c] of Object.entries(mds)) {
      await fs.mkdir(path.dirname(path.join(sb.specs, f)), { recursive: true });
      await fs.writeFile(path.join(sb.specs, f), c);
    }
    await fs.writeFile(path.join(sb.prose, "diff.patch"), changes.patch);
    if (handEdited.length) await fs.writeFile(path.join(sb.prose, "hand-edited.txt"), handEdited.join("\n") + "\n");
    await fs.writeFile(path.join(sb.state, "notes.md"), snap.notes);
    await sb.start(o.image, log);

    const first = [
      `Changes since last build: ${changes.added.length} added, ${changes.modified.length} modified, ${changes.deleted.length} deleted md files.`,
      snap.meta.builtAt ? `Last build: ${snap.meta.builtAt}` : "This is the first build (empty snapshot, empty /work).",
      "",
      "## /state/notes.md (from the previous build)",
      snap.notes || "(none)",
      "",
      "## Spec files in /specs",
      Object.keys(mds).join("\n") || "(none)",
      "",
      "## Files in /work",
      Object.keys(current).join("\n") || "(empty)",
      "",
      handEdited.length ? `## Edited by hand since last build\n${handEdited.join("\n")}\n` : "",
      "## md diff (also in /prose/diff.patch)",
      changes.patch,
    ].join("\n");

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: "system", content: SYSTEM },
      { role: "user", content: first },
    ];
    const client = new OpenAI({ apiKey: o.apiKey, baseURL: o.baseURL });
    const maxTurns = o.maxTurns ?? 150;
    let nudged = false;
    let finished: { summary: string; error?: string } | undefined;

    for (let turn = 0; turn < maxTurns && !finished; turn++) {
      if (turn === maxTurns - 15) {
        messages.push({ role: "user", content: "You are running out of turns. Stop refining, update /state/notes.md and call finish within a few turns." });
      }
      const res = await client.chat.completions.create({ model: o.model, messages, tools });
      const msg = res.choices[0].message;
      messages.push(msg as OpenAI.Chat.ChatCompletionMessageParam);
      if (msg.content) log(msg.content.trim());

      const calls = (msg.tool_calls ?? []).filter((c) => c.type === "function");
      if (calls.length === 0) {
        if (nudged) return { status: "failed", reason: "model stopped without calling finish" };
        nudged = true;
        messages.push({ role: "user", content: "Continue using tools. Call finish when done." });
        continue;
      }
      for (const c of calls) {
        let out: string;
        try {
          const args = JSON.parse(c.function.arguments || "{}");
          if (c.function.name === "bash") {
            log(`  bash: ${String(args.command).split("\n")[0].slice(0, 160)}`);
            out = await sb.exec(String(args.command ?? ""));
          } else if (c.function.name === "finish") {
            finished = { summary: String(args.summary ?? ""), error: args.error ? String(args.error) : undefined };
            log("  finish");
            out = "ok";
          } else {
            out = `error: unknown tool ${c.function.name}`;
          }
        } catch (e) {
          out = `error: ${(e as Error).message}`;
        }
        messages.push({ role: "tool", tool_call_id: c.id, content: out });
      }
    }

    if (!finished) return { status: "failed", reason: `no finish after ${maxTurns} turns; nothing written` };
    if (finished.error) return { status: "failed", reason: finished.error };

    // apply /work -> out/
    await sb.chown();
    const next = await readTree(sb.work);
    const same = (a: { data: Buffer; mode: number }, b: { data: Buffer; mode: number }) =>
      a.mode === b.mode && a.data.equals(b.data);
    const written = Object.keys(next).filter((f) => !current[f] || !same(current[f], next[f]));
    const deleted = Object.keys(current).filter((f) => !(f in next));
    if (o.dry) return { status: "built", summary: finished.summary, written, deleted };

    let notes = snap.notes;
    try { notes = await fs.readFile(path.join(sb.state, "notes.md"), "utf8"); } catch {}

    // Stage the complete new out/ and .prose/ side by side, then swap both in.
    const staging = path.join(o.root, STAGING_DIR);
    await fs.rm(staging, { recursive: true, force: true });
    await fs.mkdir(path.join(staging, "out"), { recursive: true });
    for (const [f, v] of Object.entries(next)) {
      const p = path.join(staging, "out", f);
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(p, v.data);
      await fs.chmod(p, v.mode);
    }
    await saveSnapshot(path.join(staging, "state"), {
      mds,
      outputs: Object.fromEntries(Object.entries(next).map(([f, v]) => [f, hash(v.data)])),
      notes,
      meta: { model: o.model, promptVersion: PROMPT_VERSION, builtAt: new Date().toISOString() },
    });
    const stateDir = path.join(o.root, STATE_DIR);
    await fs.rm(path.join(staging, "old-out"), { recursive: true, force: true });
    await fs.rename(outBase, path.join(staging, "old-out")).catch(() => {});
    await fs.rename(path.join(staging, "out"), outBase);
    await fs.rename(stateDir, path.join(staging, "old-state")).catch(() => {});
    await fs.rename(path.join(staging, "state"), stateDir);
    await fs.rm(staging, { recursive: true, force: true });
    return { status: "built", summary: finished.summary, written, deleted };
  } finally {
    await sb.destroy();
  }
}

/** Finish or undo a swap that was interrupted by a crash. */
async function recover(root: string) {
  const staging = path.join(root, STAGING_DIR);
  const exists = (p: string) => fs.stat(p).then(() => true, () => false);
  if (!(await exists(staging))) return;
  const out = path.join(root, OUT_DIR);
  const state = path.join(root, STATE_DIR);
  // Interrupted mid-swap: put the previous consistent pair back.
  if (await exists(path.join(staging, "old-out"))) {
    await fs.rm(out, { recursive: true, force: true });
    await fs.rename(path.join(staging, "old-out"), out);
  }
  if (await exists(path.join(staging, "old-state"))) {
    await fs.rm(state, { recursive: true, force: true });
    await fs.rename(path.join(staging, "old-state"), state);
  }
  await fs.rm(staging, { recursive: true, force: true });
}
