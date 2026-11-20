import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export const OUT_DIR = "out";
export const STATE_DIR = ".prose";
export const STAGING_DIR = ".prose-staging";
const IGNORED = new Set(["node_modules", STATE_DIR, STAGING_DIR, OUT_DIR, ".git", "dist"]);

export const hash = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

export type Msg = Record<string, any>;
/** Model conversation kept across builds so each build continues the previous ones. */
export interface History {
  /** identifies model + system prompt + tool schema; history is discarded when it changes */
  key: string;
  /** one entry per build: that build's messages (everything after the system prompt) */
  builds: Msg[][];
}

export interface Snapshot {
  history?: History;
  /** image files next to the specs (relative path -> sha256) as of the last build */
  assets: Record<string, string>;
  /** md files as of the last successful build (relative path -> content) */
  mds: Record<string, string>;
  /** output files as of the last successful build (relative to out/ -> sha256) */
  outputs: Record<string, string>;
  meta: { model?: string; promptVersion?: number; builtAt?: string; params?: Record<string, string> };
}

async function walk(dir: string, base: string, filter: (p: string) => boolean, skip: boolean): Promise<string[]> {
  const res: string[] = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return res;
  }
  for (const e of entries) {
    if (skip && IGNORED.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) res.push(...(await walk(full, base, filter, skip)));
    else if (filter(e.name)) res.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return res.sort();
}

export const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;

/** Image files next to the specs (mockups, diagrams, ...): relative path -> sha256. */
export async function readAssets(root: string): Promise<Record<string, string>> {
  const files = await walk(root, root, (n) => IMAGE_EXT.test(n), true);
  const out: Record<string, string> = {};
  for (const f of files) out[f] = hash(await fs.readFile(path.join(root, f)));
  return out;
}

export async function readMds(root: string): Promise<Record<string, string>> {
  const files = await walk(root, root, (n) => n.toLowerCase().endsWith(".md"), true);
  const out: Record<string, string> = {};
  for (const f of files) out[f] = await fs.readFile(path.join(root, f), "utf8");
  return out;
}

/** Walk a directory tree: relative path -> content + mode (regular files only). */
export async function readTree(base: string): Promise<Record<string, { data: Buffer; mode: number }>> {
  const files = await walk(base, base, () => true, false);
  const out: Record<string, { data: Buffer; mode: number }> = {};
  for (const f of files) {
    const p = path.join(base, f);
    const st = await fs.lstat(p);
    if (!st.isFile()) continue;
    out[f] = { data: await fs.readFile(p), mode: st.mode & 0o777 };
  }
  return out;
}

/** How out/ differs from what the last build produced (i.e. hand edits). */
export function drift(lock: Record<string, string>, current: Record<string, { data: Buffer }>) {
  return {
    modified: Object.keys(current).filter((f) => f in lock && lock[f] !== hash(current[f].data)),
    missing: Object.keys(lock).filter((f) => !(f in current)),
    extra: Object.keys(current).filter((f) => !(f in lock)),
  };
}

export async function loadSnapshot(root: string): Promise<Snapshot> {
  const state = path.join(root, STATE_DIR);
  const snap: Snapshot = { mds: {}, outputs: {}, assets: {}, meta: {} };
  try {
    const lock = JSON.parse(await fs.readFile(path.join(state, "lock.json"), "utf8"));
    snap.outputs = lock.outputs ?? {};
    snap.assets = lock.assets ?? {};
    snap.meta = lock.meta ?? {};
  } catch {}
  try {
    snap.history = JSON.parse(await fs.readFile(path.join(state, "history.json"), "utf8"));
  } catch {}
  const mdBase = path.join(state, "md");
  for (const f of await walk(mdBase, mdBase, () => true, false)) {
    snap.mds[f] = await fs.readFile(path.join(mdBase, f), "utf8");
  }
  return snap;
}

/** Write a snapshot into `state` (an empty/new directory). */
export async function saveSnapshot(state: string, snap: Snapshot): Promise<void> {
  for (const [f, content] of Object.entries(snap.mds)) {
    const p = path.join(state, "md", f);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, content);
  }
  await fs.mkdir(state, { recursive: true });
  if (snap.history) await fs.writeFile(path.join(state, "history.json"), JSON.stringify(snap.history));
  await fs.writeFile(
    path.join(state, "lock.json"),
    JSON.stringify({ meta: snap.meta, outputs: snap.outputs, ...(Object.keys(snap.assets).length ? { assets: snap.assets } : {}) }, null, 2) + "\n",
  );
}
