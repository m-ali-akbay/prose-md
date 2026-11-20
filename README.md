# prose

Markdown is the source code. An LLM agent compiles your `.md` specs into `out/`.

```
npm install -g prose-md      # installs the `prose` command
export DEEPSEEK_API_KEY=...   # or put it in a .env file
cd my-project                 # a directory containing .md specs
prose build
```

From a checkout instead: `npm install && npx tsx src/cli.ts build`.

Requires Docker. The target language, frameworks and layout come from the specs themselves, stated in prose.

## Commands

```
prose build [--dry] [--fresh] [--effort low|high|max] [--report FILE] [--param key=value]... ["instruction"]
prose status     md changes since the last build, and hand edits in out/
prose check [--param key=value]...   CI mode (see below)
```

- `--dry`: run the build but apply nothing.
- `--report FILE`: also write the build report (JSON: status, summary, changed files, raised issues, token usage, params, instruction) to FILE. Written for successful, dry and failed builds; never stored in `.prose/`. Without it, the same information is only printed.
- `--fresh`: ignore the saved model conversation.
- `--effort low|high|max`: the model's thinking effort, sent as `reasoning_effort` (default `low`; also `PROSE_EFFORT`). Thinking tokens are billed as output, which is most of a build's cost. Only tested against DeepSeek.
- `--param key=value` (repeatable): build parameters handed to the agent as `/prose/params.json` (target, environment, ...). They are remembered in `lock.json`, a changed value triggers a rebuild even if the specs did not change, and `--param key=` removes one.
- `"instruction"`: free text for this one build. Not remembered; forces a build.

## How it works

The compiler diffs the md files against the snapshot in `.prose/` from the last build, then runs a multi-turn tool-using LLM in a disposable Docker container (root, network access, any toolchain can be installed). The agent builds, tests and fixes inside the container. Nothing touches `out/` until it finishes.

Container layout:

- `/specs` (ro): the markdown specs
- `/prose` (ro): `diff.patch` (md changes since the last build), `params.json`, `hand-edited.txt`
- `/work`: a copy of `out/`. On `finish`, `/work` becomes `out/`: new/changed files are written, missing ones deleted, modes kept. Whatever is left in it is copied, so the agent cleans up after itself.

The agent has five tools:

- `bash`: run a command in the container.
- `view_image(path)`: look at a PNG/JPEG/GIF/WebP file (up to ~8 MB) from the container, see Images below.
- `raise(severity, message, location?)`: `info` / `warning` / `error`. Any number of times; records an issue (decisions, assumptions, ambiguities, risks) without stopping the build.
- `finish(summary)`: apply `/work` to `out/`.
- `fail(reason)`: abort. Nothing is applied and `out/` is unchanged (contradictory or too ambiguous specs). No interactive prompts, so it runs in CI.

Raised issues, the summary and token usage are printed at the end of every build. A failed build changes nothing on disk.

### Atomic apply

The new `out/` and the new `.prose/` (snapshot, lock, history) are staged in `.prose-staging/` and swapped in together. A crash mid-swap is rolled back on the next run.

### `out/` is generated-only

Files are written read-only. `prose check` fails if `out/` was changed by hand. The next build discards hand edits by regenerating those files from the specs (the agent is told which files diverged and raises a warning).

## Images (vision)

Put images next to your specs (UI mockups, diagrams, screenshots; `.png .jpg .jpeg .gif .webp`, anywhere in the project except `out/`, `.prose/`, `node_modules`). They are copied into `/specs`, listed in the agent's first message, and the agent looks at them with `view_image`. It can also look at its own results: render the output in the container (headless browser screenshot, a generated chart, ...) and view that.

- Image changes count like spec changes: their hashes are in `lock.json`, a changed, added or deleted image triggers a rebuild and is shown by `status` and `check`.
- Images are not kept in `cache.json` (replaced by a placeholder), and count as ~1000 tokens each toward the compaction limits instead of their base64 size.
- Needs a vision-capable model (`deepseek-flash` is). Only tested against DeepSeek.

## CI mode: `prose check`

Read-only verification that the last build is still valid. It needs no API key, Docker or network, and reports every problem it finds, then exits 1:

- never built (no snapshot in `.prose/`)
- md or image files changed since the last build
- `out/` differs from the last build (edited, deleted or added by hand)
- a previous build was interrupted (`.prose-staging` exists)
- with `--param key=value`: the build parameters differ from the ones the last build used

Commit `.prose/` and `out/` together with the specs, then in CI, for example:

```yaml
- uses: actions/checkout@v4
- uses: actions/setup-node@v4
- run: npx prose-md check
```

## History

The model's conversation is saved in `.prose/cache.json` and each build continues it (better cache hits; the model remembers its earlier decisions). It is replaced atomically with `out/`, dropped when a build fails, reset when the model, system prompt or tool schema changes, and ignored with `--fresh`. Size knobs, in characters (about 3-4 per token):

- `PROSE_HISTORY_LIMIT` (500000): at the **start** of a build, if the saved history is larger, it is compacted. `cache.json` is written raw at the end of a build, so it is never trimmed needlessly.
- `PROSE_HISTORY_MAX` (800000): **during** a build, before each request, if the live conversation is larger, it is compacted on the spot. Also done if the model reports its context window exceeded.
- `PROSE_HISTORY_TARGET` (100000): the size a compaction aims for. The newest messages stay raw as long as they fit; everything older (earlier builds and, mid-build, the early part of the current build) becomes a summary the model writes itself. The current build's task message is always kept. Summaries are stored, so the cached prefix stays stable until the next compaction.

`.prose/cache.json` is meant to be committed with the rest of `.prose/`, so a build on another machine or in CI continues the same conversation. It can get large (it is capped by the compaction knobs above) and is not mergeable: if two branches both build, resolve a conflict by keeping either side or deleting the file (the next build then starts a fresh conversation).

## Environment

| variable | default |
|---|---|
| `DEEPSEEK_API_KEY` (or `PROSE_API_KEY`) | required |
| `PROSE_MODEL` | `deepseek-flash` (1M context) |
| `PROSE_BASE_URL` | `https://api.deepseek.com` (any OpenAI-compatible API) |
| `PROSE_EFFORT` | `low` |
| `PROSE_IMAGE` | `ubuntu:24.04` (sandbox image) |
| `PROSE_HISTORY_LIMIT` / `_MAX` / `_TARGET` | 500000 / 800000 / 100000 |

## Examples

`examples/todo` (tiny, Python) and `examples/library` (multi-file specs: TypeScript service + Python client + Docker/Makefile).
