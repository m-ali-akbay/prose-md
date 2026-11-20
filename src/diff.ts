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
