import { promises as fs } from "node:fs";
import path from "node:path";
import OpenAI from "openai";
import { diffMds, hasChanges } from "./diff.js";
import { Sandbox } from "./sandbox.js";
import { OUT_DIR, STAGING_DIR, STATE_DIR, drift, hash, loadSnapshot, readMds, readTree, saveSnapshot } from "./snapshot.js";

export const PROMPT_VERSION = 6;

const SYSTEM = `You are the compiler of "prose": a build system where markdown files are the source code.
Your job: make /work (the project's out/ directory) implement what the markdown specs describe.

You have a disposable Docker container where you are root, with network access. You can install anything (apt, npm, pip, ...), generate code, build and test. You only have two tools: bash and finish.

Layout inside the container:
- /specs   (read-only) all markdown specs, same paths as in the project
- /prose   (read-only) params.json = build parameters (key/value strings, may be absent: interpret them as inputs to the build, e.g. target language, environment; they take precedence over defaults but not over explicit statements in the specs unless a spec says otherwise); diff.patch = md changes since the last build; hand-edited.txt = files where /work differs from what the last build produced (edited, deleted or added by hand; may be absent)
- /work    the output. It starts as a copy of the current out/. When you call finish, /work BECOMES out/: new and changed files are written, files missing from /work are deleted. Build artifacts and dependency directories you leave there will be copied too, so clean them up before finishing.

Rules:
- The markdown files are the only source of truth. Never edit them.
- Specs contain no signatures or interfaces; you design those and keep them consistent.
- The target language(s), frameworks and layout come from the specs (stated in prose in any md file). If none is stated, pick a sensible default and record it somewhere in /work (README or notes).
- Work incrementally: start from the diff and the existing /work contents. Change only what the diff requires; create, update or delete files as needed. If the target language changes, remove the old outputs.
- out/ is generated output and must never be edited by hand. Do not preserve manual edits: for every file listed in hand-edited.txt, regenerate it from the specs (restore deleted files, remove added files that the specs do not call for) and raise a warning naming those files.
- Include whatever the specs imply (tests, build files, a README for the output) in /work.
- Build and run the tests you wrote and fix failures before finishing.
- Use raise (as often as you like) to report things the author should know, with a severity: "info" (a notable decision), "warning" (an ambiguity you resolved by assuming something, a spec smell, a risk, a test you could not make pass), "error" (something is wrong but you could still finish). Raised issues are recorded in the build report; raising does not stop the build. Reference the spec file and line in the location field when you can.
- If the specs are contradictory or too ambiguous to implement without guessing something important, call fail with a short explanation of what the author must fix. Nothing is applied then.
- You have no memory between builds except what is in /work. If it helps your future self (structure, design decisions, assumptions, which spec maps to which files), keep notes in a file inside /work (e.g. NOTES.md) and keep them current; otherwise don't bother.
- If the build prompt contains an "Instruction for this build" section, follow it for this build only (it is not part of the specs and will not be remembered).
- Nothing is applied until you call finish. Every build must end with exactly one of finish or fail.`;

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
      name: "raise",
      description: "Record an issue in the build report. Can be called any number of times; does not stop the build.",
      parameters: {
        type: "object",
        properties: {
          severity: { type: "string", enum: ["info", "warning", "error"] },
          message: { type: "string" },
          location: { type: "string", description: "Optional spec location, e.g. loans.md:12" },
        },
        required: ["severity", "message"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "finish",
      description: "Successfully end the build: /work is applied to out/.",
      parameters: {
        type: "object",
        properties: { summary: { type: "string", description: "What was built or changed." } },
        required: ["summary"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fail",
      description: "Abort the build. Nothing is applied and out/ stays unchanged. Explain what the author must fix.",
      parameters: {
        type: "object",
        properties: { reason: { type: "string" } },
        required: ["reason"],
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
  /** key=value build parameters; merged over the previous build's (empty value removes) */
  params?: Record<string, string>;
  /** one-off free-text instruction for this build only */
  instruction?: string;
  log?: (s: string) => void;
}

export type Severity = "info" | "warning" | "error";
export interface Issue { severity: Severity; message: string; location?: string }

export type BuildResult =
  | { status: "unchanged" }
  | { status: "failed"; reason: string; issues: Issue[] }
  | { status: "built"; summary: string; written: string[]; deleted: string[]; issues: Issue[] };

export async function build(o: BuildOptions): Promise<BuildResult> {
  const log = o.log ?? (() => {});
  await recover(o.root);
  const snap = await loadSnapshot(o.root);
  const mds = await readMds(o.root);
  const changes = diffMds(snap.mds, mds);
  const outBase = path.join(o.root, OUT_DIR);
  const current = await readTree(outBase);
  const params: Record<string, string> = { ...(snap.meta.params ?? {}) };
  for (const [k, v] of Object.entries(o.params ?? {})) {
    if (v === "") delete params[k];
    else params[k] = v;
  }
  const paramsChanged = JSON.stringify(sortKeys(params)) !== JSON.stringify(sortKeys(snap.meta.params ?? {}));
  const d = drift(snap.outputs, current);
  if (!hasChanges(changes) && !paramsChanged && !o.instruction && d.modified.length + d.missing.length + d.extra.length === 0) return { status: "unchanged" };
  const handEdited = [...d.modified, ...d.missing, ...d.extra].sort();

  const issues: Issue[] = [];
  const report = (r: object) => JSON.stringify({ model: o.model, at: new Date().toISOString(), params, ...(o.instruction ? { instruction: o.instruction } : {}), issues, ...r }, null, 2) + "\n";
  const failed = async (reason: string): Promise<BuildResult> => {
    if (!o.dry) {
      // out/ and the snapshot stay as they were; only the report is updated
      await fs.mkdir(path.join(o.root, STATE_DIR), { recursive: true });
      await fs.writeFile(path.join(o.root, STATE_DIR, "report.json"), report({ status: "failed", reason }));
    }
    return { status: "failed", reason, issues };
  };

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
    if (Object.keys(params).length) await fs.writeFile(path.join(sb.prose, "params.json"), JSON.stringify(params, null, 2) + "\n");
    if (handEdited.length) await fs.writeFile(path.join(sb.prose, "hand-edited.txt"), handEdited.join("\n") + "\n");
    await sb.start(o.image, log);

    const first = [
      `Changes since last build: ${changes.added.length} added, ${changes.modified.length} modified, ${changes.deleted.length} deleted md files.`,
      snap.meta.builtAt ? `Last build: ${snap.meta.builtAt}` : "This is the first build (empty snapshot, empty /work).",
      "",
      Object.keys(params).length ? `## Build parameters (/prose/params.json)${paramsChanged ? " [changed since last build]" : ""}\n${JSON.stringify(params, null, 2)}\n` : "",
      o.instruction ? `## Instruction for this build (one-off)\n${o.instruction}\n` : "",
      "## Spec files in /specs",
      Object.keys(mds).join("\n") || "(none)",
      "",
      "## Files in /work",
      Object.keys(current).join("\n") || "(empty)",
      "",
      handEdited.length ? `## Changed by hand since last build (discard these edits, regenerate from the specs)\n${handEdited.join("\n")}\n` : "",
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
    let ended: { kind: "finish"; summary: string } | { kind: "fail"; reason: string } | undefined;

    for (let turn = 0; turn < maxTurns && !ended; turn++) {
      if (turn === maxTurns - 15) {
        messages.push({ role: "user", content: "You are running out of turns. Stop refining, call finish within a few turns." });
      }
      const res = await client.chat.completions.create({ model: o.model, messages, tools });
      const msg = res.choices[0].message;
      messages.push(msg as OpenAI.Chat.ChatCompletionMessageParam);
      if (msg.content) log(msg.content.trim());

      const calls = (msg.tool_calls ?? []).filter((c) => c.type === "function");
      if (calls.length === 0) {
        if (nudged) return failed("model stopped without calling finish or fail");
        nudged = true;
        messages.push({ role: "user", content: "Continue using tools. Call finish when done, or fail if blocked." });
        continue;
      }
      for (const c of calls) {
        let out: string;
        try {
          const args = JSON.parse(c.function.arguments || "{}");
          if (c.function.name === "bash") {
            log(`  bash: ${String(args.command).split("\n")[0].slice(0, 160)}`);
            out = await sb.exec(String(args.command ?? ""));
          } else if (c.function.name === "raise") {
            const sev = ["info", "warning", "error"].includes(args.severity) ? (args.severity as Severity) : "warning";
            const issue: Issue = { severity: sev, message: String(args.message ?? ""), ...(args.location ? { location: String(args.location) } : {}) };
            issues.push(issue);
            log(`  raise ${sev}: ${issue.message.slice(0, 160)}`);
            out = `recorded (#${issues.length})`;
          } else if (c.function.name === "finish") {
            ended = { kind: "finish", summary: String(args.summary ?? "") };
            log("  finish");
            out = "ok";
          } else if (c.function.name === "fail") {
            ended = { kind: "fail", reason: String(args.reason ?? "") };
            log("  fail");
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

    if (!ended) return failed(`no finish or fail after ${maxTurns} turns; nothing written`);
    if (ended.kind === "fail") return failed(ended.reason);
    const summary = ended.summary;

    // apply /work -> out/
    await sb.chown();
    const next = await readTree(sb.work);
    const same = (a: { data: Buffer; mode: number }, b: { data: Buffer; mode: number }) =>
      (a.mode & 0o555) === (b.mode & 0o555) && a.data.equals(b.data);
    const written = Object.keys(next).filter((f) => !current[f] || !same(current[f], next[f]));
    const deleted = Object.keys(current).filter((f) => !(f in next));
    if (o.dry) return { status: "built", summary, written, deleted, issues };

    // Stage the complete new out/ and .prose/ side by side, then swap both in.
    const staging = path.join(o.root, STAGING_DIR);
    await fs.rm(staging, { recursive: true, force: true });
    await fs.mkdir(path.join(staging, "out"), { recursive: true });
    for (const [f, v] of Object.entries(next)) {
      const p = path.join(staging, "out", f);
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(p, v.data);
      await fs.chmod(p, v.mode & 0o555); // generated output is read-only
    }
    await saveSnapshot(path.join(staging, "state"), {
      mds,
      outputs: Object.fromEntries(Object.entries(next).map(([f, v]) => [f, hash(v.data)])),
      meta: { model: o.model, promptVersion: PROMPT_VERSION, builtAt: new Date().toISOString(), params },
    });
    await fs.writeFile(path.join(staging, "state", "report.json"), report({ status: "built", summary, written, deleted }));
    const stateDir = path.join(o.root, STATE_DIR);
    await fs.rm(path.join(staging, "old-out"), { recursive: true, force: true });
    await fs.rename(outBase, path.join(staging, "old-out")).catch(() => {});
    await fs.rename(path.join(staging, "out"), outBase);
    await fs.rename(stateDir, path.join(staging, "old-state")).catch(() => {});
    await fs.rename(path.join(staging, "state"), stateDir);
    await fs.rm(staging, { recursive: true, force: true });
    return { status: "built", summary, written, deleted, issues };
  } finally {
    await sb.destroy();
  }
}

function sortKeys(o: Record<string, string>) {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
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
