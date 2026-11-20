import { createTwoFilesPatch } from "diff";

export interface MdChanges {
  added: string[];
  modified: string[];
  deleted: string[];
  patch: string;
}

export function diffMds(prev: Record<string, string>, cur: Record<string, string>): MdChanges {
  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  const patches: string[] = [];
  for (const f of Object.keys(cur)) {
    if (!(f in prev)) {
      added.push(f);
      patches.push(createTwoFilesPatch("/dev/null", f, "", cur[f], "", "", { context: 3 }));
    } else if (prev[f] !== cur[f]) {
      modified.push(f);
      patches.push(createTwoFilesPatch(f, f, prev[f], cur[f], "previous build", "now", { context: 3 }));
    }
  }
  for (const f of Object.keys(prev)) {
    if (!(f in cur)) {
      deleted.push(f);
      patches.push(createTwoFilesPatch(f, "/dev/null", prev[f], "", "", "", { context: 3 }));
    }
  }
  return { added, modified, deleted, patch: patches.join("\n") };
}

export const hasChanges = (c: MdChanges) => c.added.length + c.modified.length + c.deleted.length > 0;

export interface AssetChanges {
  added: string[];
  modified: string[];
  deleted: string[];
  patch: string;
  any: boolean;
}

/** Image assets are binary: report which ones changed (hashes only). */
export function diffAssets(prev: Record<string, string>, cur: Record<string, string>): AssetChanges {
  const added = Object.keys(cur).filter((f) => !(f in prev));
  const modified = Object.keys(cur).filter((f) => f in prev && prev[f] !== cur[f]);
  const deleted = Object.keys(prev).filter((f) => !(f in cur));
  const lines = [
    ...added.map((f) => `added image:    ${f}`),
    ...modified.map((f) => `modified image: ${f}`),
    ...deleted.map((f) => `deleted image:  ${f}`),
  ];
  return {
    added, modified, deleted,
    patch: lines.length ? `Image assets changed since the last build (binary, look at them with view_image):\n${lines.join("\n")}\n` : "",
    any: lines.length > 0,
  };
}
