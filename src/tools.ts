import path from "node:path";
import { OUT_DIR, hash } from "./snapshot.js";
import type { MdChanges } from "./diff.js";

export interface BuildState {
  prevOutputs: Record<string, string>; // path -> hash from last build
  outputs: Record<string, string>; // path -> content (staged, live view)
  mds: Record<string, string>;
  changes: MdChanges;
  notes: string;
  exec?: (command: string) => Promise<string>;
  finished?: string;
  questions?: string[];
}

const runCommandDef: [string, string, Record<string, string>] = [
  "run_command",
  "Run a bash command as root in a disposable Docker container with network access. /work mirrors the current staged outputs (out/). State (installed packages, node_modules) persists between calls within this build. Returns exit code and output.",
  { command: "string" },
];

const baseDefs: [string, string, Record<string, string>][] = [
  ["list_md", "List all markdown spec files with sizes.", {}],
  ["read_md", "Read a markdown spec file.", { path: "string" }],
  ["get_md_diff", "Get the unified diff of all md files since the last successful build.", {}],
  ["list_outputs", "List current output files under out/. Flags files edited by hand since the last build.", {}],
  ["read_output", "Read an output file (path relative to out/).", { path: "string" }],
  ["write_output", "Create or overwrite an output file (path relative to out/).", { path: "string", content: "string" }],
  ["delete_output", "Delete an output file (path relative to out/).", { path: "string" }],
  ["write_notes", "Replace the build notes. Notes persist to the next build; record structure, decisions, which spec produced which files.", { content: "string" }],
  ["ask_user", "Abort the build and ask the author questions when the specs are ambiguous or contradictory. Nothing is written.", { questions: "array" }],
  ["finish", "Finish the build and commit all staged changes.", { summary: "string" }],
];

export const makeToolDefs = (verify: boolean) => (verify ? [...baseDefs.slice(0, -1), runCommandDef, baseDefs[baseDefs.length - 1]] : baseDefs).map(([name, description, props]) => ({
  type: "function" as const,
  function: {
    name: name as string,
    description: description as string,
    parameters: {
      type: "object",
      properties: Object.fromEntries(
        Object.entries(props as Record<string, string>).map(([k, t]) => [
          k,
          t === "array" ? { type: "array", items: { type: "string" } } : { type: t },
        ]),
      ),
      required: Object.keys(props as object),
    },
  },
}));

function safe(p: unknown): string {
  if (typeof p !== "string" || !p) throw new Error("path is required");
  const norm = path.posix.normalize(p.replace(/\\/g, "/").replace(/^(\.\/)?(out\/)?/, ""));
  if (norm.startsWith("..") || path.posix.isAbsolute(norm) || norm === ".") {
    throw new Error(`path must be inside ${OUT_DIR}/: ${p}`);
  }
  return norm;
}

export async function runTool(s: BuildState, name: string, a: any): Promise<string> {
  switch (name) {
    case "list_md":
      return Object.entries(s.mds).map(([f, c]) => `${f} (${c.length} chars)`).join("\n") || "(none)";
    case "read_md": {
      const c = s.mds[a.path];
      if (c === undefined) throw new Error(`no such md file: ${a.path}`);
      return c;
    }
    case "get_md_diff":
      return s.changes.patch || "(no changes)";
    case "list_outputs": {
      const lines = Object.entries(s.outputs).map(([f, c]) => {
        const prev = s.prevOutputs[f];
        const flag = prev === undefined ? " [new]" : prev !== hash(c) ? " [changed since last build]" : "";
        return f + flag;
      });
      return lines.join("\n") || "(none)";
    }
    case "read_output": {
      const c = s.outputs[safe(a.path)];
      if (c === undefined) throw new Error(`no such output file: ${a.path}`);
      return c;
    }
    case "write_output":
      s.outputs[safe(a.path)] = String(a.content ?? "");
      return `wrote ${safe(a.path)}`;
    case "delete_output": {
      const p = safe(a.path);
      if (!(p in s.outputs)) throw new Error(`no such output file: ${a.path}`);
      delete s.outputs[p];
      return `deleted ${p}`;
    }
    case "run_command":
      if (!s.exec) throw new Error("run_command is not enabled");
      return await s.exec(String(a.command ?? ""));
    case "write_notes":
      s.notes = String(a.content ?? "");
      return "notes updated";
    case "ask_user":
      s.questions = (a.questions as string[]) ?? [];
      return "questions recorded";
    case "finish":
      s.finished = String(a.summary ?? "");
      return "ok";
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}
