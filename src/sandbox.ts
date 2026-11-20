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
 * A disposable Docker container the agent has full root control over
 * (network, package installs, any tool). Host dirs are bind-mounted:
 *   /work   rw  copy of out/ (whatever is here at the end becomes out/)
 *   /specs  ro  the current markdown specs
 *   /prose  ro  build context (diff, hand-edited files)
 */
export class Sandbox {
  readonly work: string;
  readonly specs: string;
  readonly prose: string;
  private constructor(private name: string, private base: string) {
    this.work = path.join(base, "work");
    this.specs = path.join(base, "specs");
    this.prose = path.join(base, "prose");
  }

  static async checkDocker() {
    const v = await run(["version", "--format", "{{.Server.Version}}"], 15_000);
    if (v.code !== 0) throw new Error("Docker is not available. Start Docker and try again.");
  }

  static async create(): Promise<Sandbox> {
    await Sandbox.checkDocker();
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "prose-"));
    const sb = new Sandbox(`prose-${path.basename(base).slice(6)}`, base);
    for (const d of [sb.work, sb.specs, sb.prose]) await fs.mkdir(d);
    return sb;
  }

  async start(image: string, log: (s: string) => void) {
    log(`sandbox: starting ${image}`);
    const r = await run(
      [
        "run", "-d", "--name", this.name,
        "-v", `${this.work}:/work`, "-v", `${this.specs}:/specs:ro`,
        "-v", `${this.prose}:/prose:ro`,
        "-w", "/work", "-e", "CI=1", "-e", "DEBIAN_FRONTEND=noninteractive",
        image, "sleep", "infinity",
      ],
      600_000,
    );
    if (r.code !== 0) throw new Error(`failed to start sandbox: ${r.stderr}`);
  }

  async exec(command: string): Promise<string> {
    const r = await run(["exec", this.name, "bash", "-lc", command], 15 * 60_000);
    let out = `exit code: ${r.code}\n${r.stdout}${r.stderr ? "\n[stderr]\n" + r.stderr : ""}`;
    if (out.length > 12000) out = out.slice(0, 3000) + "\n...[truncated]...\n" + out.slice(-9000);
    return out;
  }

  /** Give the host user ownership of root-created files so they can be read/removed. */
  async chown() {
    if (process.getuid && process.getgid) {
      await run(["exec", this.name, "chown", "-R", `${process.getuid()}:${process.getgid()}`, "/work"], 300_000);
    }
  }

  async destroy() {
    await this.chown().catch(() => {});
    await run(["rm", "-f", this.name], 30_000);
    await fs.rm(this.base, { recursive: true, force: true }).catch(() => {});
  }
}
