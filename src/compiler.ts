import { promises as fs } from "node:fs";
import path from "node:path";
import OpenAI from "openai";
import { diffMds, hasChanges } from "./diff.js";
import {
  OUT_DIR, hash, loadSnapshot, readMds, readOutputs, saveSnapshot,
} from "./snapshot.js";
import { exec as cpExec } from "node:child_process";
import os from "node:os";
import { BuildState, makeToolDefs, runTool } from "./tools.js";

export const PROMPT_VERSION = 1;

const SYSTEM = `You are the compiler of "prose": a build system where markdown files are the source code.
Your job: make the files under out/ implement what the markdown specs describe.

Rules:
- The markdown files are the only source of truth. Never edit them.
- Spec files contain no signatures or interfaces; you design those. Keep the design consistent across all outputs.
- The target language(s), frameworks and layout come from the specs (mentioned in prose in any md file). If none is stated and you cannot reasonably infer one, call ask_user.
- If specs are ambiguous or contradictory in a way that changes behavior, call ask_user instead of guessing. Do not ask about trivia.
- Work incrementally: start from the md diff and the existing outputs. Update only what the diff requires; create, update or delete output files as needed. If the target language changes, remove the old outputs.
- Outputs flagged "[changed since last build]" were edited by hand; preserve their intent unless the specs contradict them.
- Include whatever the specs imply (tests, build files, README for the output) inside out/.
- Before finish, call write_notes with concise notes for your future self: project structure, key design decisions, which spec maps to which output files, anything pending. Notes are rewritten in full each time.
- If run_command is available, install dependencies, build and run the tests you wrote, and fix failures before finishing. Do not finish with failing tests unless the specs make that unavoidable (then say so in the summary).
- When done, call finish. Nothing is committed until you do.`;

export interface BuildOptions {
  root: string;
  model: string;
  apiKey: string;
  baseURL: string;
  maxTurns?: number;
  dry?: boolean;
  /** allow the agent to run shell commands (tests etc.) in a scratch dir */
  verify?: boolean;
  log?: (s: string) => void;
}

export type BuildResult =
  | { status: "unchanged" }
  | { status: "questions"; questions: string[] }
  | { status: "failed"; reason: string }
  | { status: "built"; summary: string; written: string[]; deleted: string[] };

export async function build(o: BuildOptions): Promise<BuildResult> {
  const log = o.log ?? (() => {});
  const snap = await loadSnapshot(o.root);
  const mds = await readMds(o.root);
  const changes = diffMds(snap.mds, mds);
  const modelChanged = snap.meta.model !== undefined && snap.meta.model !== o.model;
  if (!hasChanges(changes)) return { status: "unchanged" };

  const current = await readOutputs(o.root);
  const state: BuildState = {
    prevOutputs: snap.outputs,
    outputs: { ...current },
    mds,
    changes,
    notes: snap.notes,
  };

  let scratch: string | undefined;
  const synced = new Set<string>();
  if (o.verify) {
    scratch = await fs.mkdtemp(path.join(os.tmpdir(), "prose-"));
    state.exec = async (command) => {
      for (const f of synced) if (!(f in state.outputs)) await fs.rm(path.join(scratch!, f), { force: true });
      synced.clear();
      for (const [f, c] of Object.entries(state.outputs)) {
        await fs.mkdir(path.dirname(path.join(scratch!, f)), { recursive: true });
        await fs.writeFile(path.join(scratch!, f), c);
        synced.add(f);
      }
      return new Promise<string>((resolve) => {
        cpExec(command, { cwd: scratch, timeout: 180_000, maxBuffer: 10 * 1024 * 1024, env: { ...process.env, CI: "1" } }, (err, stdout, stderr) => {
          const code = err ? ((err as any).killed ? "timeout" : ((err as any).code ?? 1)) : 0;
          let out = `exit code: ${code}\n${stdout}${stderr ? "\n[stderr]\n" + stderr : ""}`;
          if (out.length > 12000) out = out.slice(0, 3000) + "\n...[truncated]...\n" + out.slice(-9000);
          resolve(out);
        });
      });
    };
  }

  const client = new OpenAI({ apiKey: o.apiKey, baseURL: o.baseURL });
  const first = [
    `Changes since last build: ${changes.added.length} added, ${changes.modified.length} modified, ${changes.deleted.length} deleted md files.`,
    snap.meta.builtAt ? `Last build: ${snap.meta.builtAt}` : "This is the first build (empty snapshot).",
    "",
    "## Notes from the previous build",
    snap.notes || "(none)",
    "",
    "## Spec files",
    Object.keys(mds).join("\n") || "(none)",
    "",
    "## Current output files",
    Object.entries(current)
      .map(([f, c]) => (snap.outputs[f] !== undefined && snap.outputs[f] !== hash(c) ? `${f} [changed since last build]` : f))
      .join("\n") || "(none)",
    "",
    "## md diff",
    changes.patch,
  ].join("\n");

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM },
    { role: "user", content: first },
  ];

  const maxTurns = o.maxTurns ?? 150;
  let nudged = false;
  for (let turn = 0; turn < maxTurns && !state.finished && !state.questions; turn++) {
    if (turn === maxTurns - 15) {
      messages.push({ role: "user", content: "You are running out of turns. Stop refining, write_notes and call finish within a few turns." });
    }
    const res = await client.chat.completions.create({
      model: o.model,
      messages,
      tools: makeToolDefs(!!o.verify),
    });
    const msg = res.choices[0].message;
    messages.push(msg as OpenAI.Chat.ChatCompletionMessageParam);
    if (msg.content) log(msg.content.trim());

    const calls = (msg.tool_calls ?? []).filter((c) => c.type === "function");
    if (calls.length === 0) {
      if (nudged) {
        if (scratch) await fs.rm(scratch, { recursive: true, force: true });
        return { status: "failed", reason: "model stopped without calling finish or ask_user" };
      }
      nudged = true;
      messages.push({ role: "user", content: "Continue using tools. Call finish when done, or ask_user if blocked." });
      continue;
    }
    for (const c of calls) {
      let out: string;
      try {
        const args = JSON.parse(c.function.arguments || "{}");
        out = await runTool(state, c.function.name, args);
        log(`  ${c.function.name}${args.path ? " " + args.path : ""}${args.command ? ": " + args.command : ""}`);
      } catch (e) {
        out = `error: ${(e as Error).message}`;
        log(`  ${c.function.name} -> ${out}`);
      }
      messages.push({ role: "tool", tool_call_id: c.id, content: out });
    }
  }

  if (scratch) await fs.rm(scratch, { recursive: true, force: true });
  if (state.questions) return { status: "questions", questions: state.questions };
  if (state.finished === undefined) return { status: "failed", reason: `no finish after ${maxTurns} turns; nothing written` };

  const written = Object.keys(state.outputs).filter((f) => current[f] !== state.outputs[f]);
  const deleted = Object.keys(current).filter((f) => !(f in state.outputs));
  if (o.dry) return { status: "built", summary: state.finished, written, deleted };

  const outBase = path.join(o.root, OUT_DIR);
  for (const f of deleted) await fs.rm(path.join(outBase, f), { force: true });
  for (const f of written) {
    await fs.mkdir(path.dirname(path.join(outBase, f)), { recursive: true });
    await fs.writeFile(path.join(outBase, f), state.outputs[f]);
  }
  await pruneEmptyDirs(outBase);

  await saveSnapshot(o.root, {
    mds,
    outputs: Object.fromEntries(Object.entries(state.outputs).map(([f, c]) => [f, hash(c)])),
    notes: state.notes,
    meta: { model: o.model, promptVersion: PROMPT_VERSION, builtAt: new Date().toISOString() },
  });
  void modelChanged;
  return { status: "built", summary: state.finished, written, deleted };
}

async function pruneEmptyDirs(dir: string): Promise<boolean> {
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return true; }
  let empty = true;
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!(await pruneEmptyDirs(path.join(dir, e.name)))) empty = false;
    } else empty = false;
  }
  if (empty) await fs.rmdir(dir).catch(() => {});
  return empty;
}
