import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const run = (args: string[], timeout = 60_000) =>
  new Promise<{ code: number | string; stdout: string; stderr: string }>((resolve) => {
    execFile("docker", args, { timeout, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ code: err ? ((err as any).killed ? "timeout" : ((err as any).code ?? 1)) : 0, stdout, stderr }),
    );
  });

/**
 * A disposable Docker container the agent has full root control over:
 * network access, package installs, any tool. Staged outputs are synced into /work.
 */
export class Sandbox {
  private synced = new Set<string>();
  private constructor(private name: string, private dir: string) {}

  static async start(image: string, log: (s: string) => void): Promise<Sandbox> {
    const v = await run(["version", "--format", "{{.Server.Version}}"], 15_000);
    if (v.code !== 0) throw new Error("Docker is not available. Start Docker, or pass --no-sandbox to build without running commands.");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "prose-"));
    const name = `prose-${path.basename(dir).slice(6)}`;
    log(`sandbox: starting ${image}`);
    const r = await run(
      ["run", "-d", "--name", name, "-v", `${dir}:/work`, "-w", "/work", "-e", "CI=1", "-e", "DEBIAN_FRONTEND=noninteractive", image, "sleep", "infinity"],
      600_000,
    );
    if (r.code !== 0) {
      await fs.rm(dir, { recursive: true, force: true });
      throw new Error(`failed to start sandbox: ${r.stderr}`);
    }
    return new Sandbox(name, dir);
  }

  /** Mirror the staged outputs into /work (root of out/). */
  async sync(files: Record<string, string>) {
    for (const f of this.synced) if (!(f in files)) await fs.rm(path.join(this.dir, f), { force: true });
    this.synced.clear();
    for (const [f, c] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(this.dir, f)), { recursive: true });
      await fs.writeFile(path.join(this.dir, f), c);
      this.synced.add(f);
    }
  }

  async exec(command: string): Promise<string> {
    const r = await run(["exec", this.name, "bash", "-lc", command], 15 * 60_000);
    let out = `exit code: ${r.code}\n${r.stdout}${r.stderr ? "\n[stderr]\n" + r.stderr : ""}`;
    if (out.length > 12000) out = out.slice(0, 3000) + "\n...[truncated]...\n" + out.slice(-9000);
    return out;
  }

  async destroy() {
    await run(["rm", "-f", this.name], 30_000);
    // files written by root inside the container may need the container to chown first
    await fs.rm(this.dir, { recursive: true, force: true }).catch(() => {});
  }
}
