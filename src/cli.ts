#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { build, type Issue } from "./compiler.js";
import { diffMds, hasChanges } from "./diff.js";
import { OUT_DIR, drift, loadSnapshot, readMds, readTree } from "./snapshot.js";

async function loadDotEnv(root: string) {
  try {
    for (const line of (await fs.readFile(path.join(root, ".env"), "utf8")).split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {}
}

const HELP = `prose - compile markdown into code

  prose build [--dry] [--fresh] [--param key=value]... ["instruction"]
                        compile md changes into out/. The agent works in a root
                        Docker container (build, test, install anything).
                        --fresh: ignore the saved model conversation (.prose/history.json).
                        --param: build parameters given to the agent (target, env, ...).
                          Remembered across builds; changing one triggers a rebuild;
                          --param key= removes it.
                        "instruction": free text for this build only; forces a build.
  prose status          show md changes since the last build
  prose check           exit 1 if md files changed since the last build (no LLM call)

env: DEEPSEEK_API_KEY (or PROSE_API_KEY), PROSE_MODEL (default deepseek-flash),
     PROSE_BASE_URL (default https://api.deepseek.com),
     PROSE_IMAGE (sandbox image, default ubuntu:24.04),
     PROSE_HISTORY_LIMIT (start of build: compact the saved conversation above this many chars, default 500000),
     PROSE_HISTORY_MAX (during a build: compact as soon as the conversation exceeds this, default 800000),
     PROSE_HISTORY_TARGET (chars a compaction brings it down to, default 100000)`;

const printIssues = (issues: Issue[]) => {
  if (!issues.length) return;
  console.log("\nRaised:");
  for (const i of issues) console.log(`  [${i.severity}]${i.location ? " " + i.location + ":" : ""} ${i.message}`);
};

async function main() {
  const [cmd = "help", ...rest] = process.argv.slice(2);
  const flags: string[] = [];
  const params: Record<string, string> = {};
  const words: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--param" || a.startsWith("--param=")) {
      const kv = a === "--param" ? rest[++i] ?? "" : a.slice("--param=".length);
      const eq = kv.indexOf("=");
      if (eq < 1) {
        console.error(`bad --param "${kv}", expected key=value`);
        process.exit(1);
      }
      params[kv.slice(0, eq)] = kv.slice(eq + 1);
    } else if (a.startsWith("--")) flags.push(a);
    else words.push(a);
  }
  const root = process.cwd();
  await loadDotEnv(root);

  if (cmd === "status" || cmd === "check") {
    const snap = await loadSnapshot(root);
    const changes = diffMds(snap.mds, await readMds(root));
    const d = drift(snap.outputs, await readTree(path.join(root, OUT_DIR)));
    const hand = [...d.modified.map((f) => `modified ${f}`), ...d.missing.map((f) => `deleted  ${f}`), ...d.extra.map((f) => `added    ${f}`)];
    const stale = hasChanges(changes) || hand.length > 0;
    if (cmd === "status") {
      if (hasChanges(changes)) console.log(changes.patch);
      if (hand.length) console.log(`out/ was changed by hand (a build will discard this):\n  ${hand.join("\n  ")}`);
      if (!stale) console.log("up to date");
    } else if (stale) {
      console.error(hasChanges(changes) ? "stale: md files changed since last build" : "out/ was changed by hand since last build");
      process.exit(1);
    }
    return;
  }

  if (cmd === "build") {
    const apiKey = process.env.PROSE_API_KEY ?? process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
      console.error("Set DEEPSEEK_API_KEY (env or .env file).");
      process.exit(1);
    }
    const r = await build({
      root,
      apiKey,
      model: process.env.PROSE_MODEL ?? "deepseek-flash",
      baseURL: process.env.PROSE_BASE_URL ?? "https://api.deepseek.com",
      dry: flags.includes("--dry"),
      fresh: flags.includes("--fresh"),
      historyLimit: process.env.PROSE_HISTORY_LIMIT ? Number(process.env.PROSE_HISTORY_LIMIT) : undefined,
      historyMax: process.env.PROSE_HISTORY_MAX ? Number(process.env.PROSE_HISTORY_MAX) : undefined,
      historyTarget: process.env.PROSE_HISTORY_TARGET ? Number(process.env.PROSE_HISTORY_TARGET) : undefined,
      params,
      instruction: words.join(" ").trim() || undefined,
      image: process.env.PROSE_IMAGE ?? "ubuntu:24.04",
      log: (s) => console.log(s),
    });
    switch (r.status) {
      case "unchanged":
        console.log("up to date");
        break;
      case "failed":
        printIssues(r.issues);
        console.error(`\nBuild failed (nothing written): ${r.reason}`);
        process.exit(1);
      case "built":
        printIssues(r.issues);
        console.log(`\n${r.summary}\n+${r.written.length} written, -${r.deleted.length} deleted${flags.includes("--dry") ? " (dry run)" : ""}`);
    }
    return;
  }
  console.log(HELP);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
