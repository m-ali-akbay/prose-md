# prose

Markdown is the source code. An LLM agent compiles md changes into `out/`.

```
npm install
export DEEPSEEK_API_KEY=...   # or put it in .env
npx tsx src/cli.ts build      # run inside a project containing .md specs
```

Commands: `build [--dry] [--no-sandbox]`, `status`, `check`.

**Sandbox:** the agent works inside a disposable Docker container (root, network access, `/work` mirrors `out/`). It can install any toolchain, build, run tests and fix failures before finishing, so any language or stack works. Requires Docker; image via `PROSE_IMAGE` (default `ubuntu:24.04`). `--no-sandbox` disables command execution. Model via `PROSE_MODEL` (`deepseek-reasoner` is better for harder projects).

How it works: the compiler diffs the md files against the snapshot in `.prose/` from the last build, then runs a multi-turn tool-using LLM that creates, updates or deletes files in `out/`, or fails the build if the specs can't be implemented. Changes are applied only when the model finishes. The target language comes from the specs themselves.

Examples: `examples/todo` (tiny, Python) and `examples/library` (multi-file specs: TypeScript service + Python client + Docker/Makefile).
