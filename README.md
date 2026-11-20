# prose

Markdown is the source code. An LLM agent compiles md changes into `out/`.

```
npm install
export DEEPSEEK_API_KEY=...   # or put it in .env
npx tsx src/cli.ts build      # run inside a project containing .md specs
```

Commands: `build [--dry]`, `status`, `check`.

How it works: the compiler diffs the md files against the snapshot in `.prose/` from the last build, then runs a multi-turn tool-using LLM that creates, updates or deletes files in `out/`, or asks questions if the specs are ambiguous. Changes are applied only when the model finishes. The target language comes from the specs themselves.

See `examples/todo` for a built project.
