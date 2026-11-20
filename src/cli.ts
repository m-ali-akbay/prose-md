#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { build } from "./compiler.js";
import { diffMds, hasChanges } from "./diff.js";
import { loadSnapshot, readMds } from "./snapshot.js";

async function loadDotEnv(root: string) {
  try {
    for (const line of (await fs.readFile(path.join(root, ".env"), "utf8")).split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {}
}

const HELP = `prose - compile markdown into code

  prose build [--dry] [--no-sandbox]
                        compile md changes into out/. The agent works in a
                        root Docker container (build, test, install anything)
  prose status          show md changes since the last build
  prose check           exit 1 if md files changed since the last build (no LLM call)

env: DEEPSEEK_API_KEY (or PROSE_API_KEY), PROSE_MODEL (default deepseek-chat),
     PROSE_BASE_URL (default https://api.deepseek.com),
     PROSE_IMAGE (sandbox image, default ubuntu:24.04)`;

async function main() {
  const [cmd = "help", ...flags] = process.argv.slice(2);
  const root = process.cwd();
  await loadDotEnv(root);

  if (cmd === "status" || cmd === "check") {
    const changes = diffMds((await loadSnapshot(root)).mds, await readMds(root));
    if (cmd === "status") {
      console.log(hasChanges(changes) ? changes.patch : "up to date");
    } else if (hasChanges(changes)) {
      console.error("stale: md files changed since last build");
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
      model: process.env.PROSE_MODEL ?? "deepseek-chat",
      baseURL: process.env.PROSE_BASE_URL ?? "https://api.deepseek.com",
      dry: flags.includes("--dry"),
      noSandbox: flags.includes("--no-sandbox"),
      image: process.env.PROSE_IMAGE ?? "ubuntu:24.04",
      log: (s) => console.log(s),
    });
    switch (r.status) {
      case "unchanged":
        console.log("up to date");
        break;
      case "questions":
        console.error("\nBuild blocked. Resolve in the md files:");
        r.questions.forEach((q) => console.error(`  - ${q}`));
        process.exit(2);
      case "failed":
        console.error(`\nBuild failed: ${r.reason}`);
        process.exit(1);
      case "built":
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
