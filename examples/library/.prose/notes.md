# Library lending service — build notes

## Specs → outputs
- `library.md` (TypeScript/Node, plain `node:http`, in-memory, `node:test`) → `src/`, `package.json`, `tsconfig.json`, `test/`
- `books.md` → book rules in `src/library.ts` (`addBook`, `listBooks`, `getBook`, `removeBook`), routes in `src/server.ts`
- `members.md` → member rules in `src/library.ts` (`registerMember`, `suspendMember`, `unsuspendMember`)
- `loans.md` → loan rules in `src/library.ts` (`borrowBook`, `returnLoan`, `renewLoan`, `loanHistory`, `overdueLoans`), `src/clock.ts` (`X-Fake-Now`)
- `cli.md` → `client/libctl` (single-file Python 3 client, stdlib only)
- `docs/packaging.md` → `Dockerfile` (multi-stage, node:22-alpine, `USER node`, HEALTHCHECK), `Makefile` (test/run/docker/install/build/clean), `README.md`

## Structure
- `src/index.ts` — entry point; `PORT` (default 8080), SIGINT/SIGTERM shutdown
- `src/server.ts` — routing + JSON plumbing; `createServer(library?)` returns `{server, library}` (tests bind port 0)
- `src/library.ts` — the whole domain; every time-dependent method takes an explicit `now: Date`; returns already-API-shaped views
- `src/clock.ts` — `resolveNow(header)`, `addDays`, `daysBetween`, `MS_PER_DAY`
- `src/errors.ts` — `HttpError{status, code}` + `badRequest/notFound/conflict/methodNotAllowed`
- `src/validate.ts` — payload/query validation helpers
- `test/helpers.ts` — boots a server on an ephemeral port + fetch helper; **CLI tests must use async `execFile`** (spawnSync would deadlock the in-process server)

## API design decisions (kept consistent in README + client)
- Collections wrapped: `{books|members|loans: [...]}`; single entities returned bare.
- Errors: `{error, code}` with codes NOT_FOUND/VALIDATION_ERROR/BAD_JSON/INVALID_FAKE_NOW/METHOD_NOT_ALLOWED/DUPLICATE_EMAIL/NO_COPIES/MEMBER_SUSPENDED/LOAN_LIMIT/MEMBER_OVERDUE/BOOK_ON_LOAN/ALREADY_RETURNED/ALREADY_RENEWED/LOAN_OVERDUE.
- ISBN identity ignores case/space/hyphen; re-adding an ISBN adds copies and returns **200** (create = 201), keeps original title/author.
- Email stored lower-cased; duplicate → 409.
- `suspendedUntil` ISO date on the member (+ derived `suspended`), so suspensions expire automatically with time travel.
- "More than 14 days late" = returned > dueAt + 14 days (exactly 14 days late does NOT suspend). Suspension = return time + 7 days.
- Renewal allowed while `now <= dueAt`; second renewal → 409.
- **Renewal is also refused while the member is suspended** (`409 MEMBER_SUSPENDED`, spec loans.md). Check order in `renewLoan`: returned → suspended → already-renewed → overdue. A refused renewal does not consume the single allowed renewal.
- Borrow check order follows loans.md: copies → suspension → 5-loan limit → overdue loan.
- **Loan history view**: `GET /members/{id}/loans` → `{loans: [...]}`, all loans of the member (active + returned), newest first (`borrowedAt` desc, tie-break `dueAt` desc). Implemented by `Library.loanHistory`; unknown member → 404. Client command: `libctl history --member <id>`.
- Extra endpoints beyond the specs' explicit list: `GET /`, `/health`, `GET /books/{id}`, `GET /members/{id}`, `GET /loans/{id}`, `GET /loans`, `POST /members/{id}/suspend|unsuspend`.
- `GET /loans/{id}` is implemented by scanning `listLoans({})` — fine at this scale; add a `getLoan` to `Library` if it ever matters.
- Client extras beyond cli.md: `list-books`, `list-members`, `renew`, `history`, global `--url` and `--now` (sends X-Fake-Now). All commands accept the flags *after* the subcommand (argparse parent parser).

## Build/test
- `npm install && npm test` (tsc → `dist/`, then `node --test dist/test/*.test.js`). 46 tests pass (books 5, members 5, loans 18, time 7, cli 6 — CLI tests skip if `python3` missing). Verified `make test` too.
- **dist/ is no longer part of out/** (gitignored build artifact; stale copies were misleading). Run `npm run build` / `make build` first, then `npm start`.
- `node_modules/` is still present under out/ but the build tool strips exec bits, so `node_modules/.bin/tsc` fails with "Permission denied". Fix in a scratch copy with `rm -rf node_modules && npm install` before running `npm test`.
- Dockerfile uses `npm install` (npm's engine pinning picks TypeScript 5.9 / @types/node 22 even though package.json says ^5.7 / ^22.10); no runtime dependencies.

## Pending / watch out
- No persistence (in-memory by design); restarting clears data.
- `client/libctl` should be run as `python3 client/libctl` (exec bit is not preserved by the build).
- If a spec later asks for book delete confirmation, authors as objects, history pagination, etc., extend `Library` views + the README API table + the client together.
