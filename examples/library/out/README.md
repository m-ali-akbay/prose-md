# Library lending service

An HTTP JSON service for a small public library, written in TypeScript for
Node.js with **no web framework** (plain `node:http`) and an **in-memory**
store. A Python 3 command line client (`libctl`, standard library only) is
included.

## Layout

```
src/        service sources (TypeScript)
  index.ts    entry point: PORT, graceful shutdown
  server.ts   node:http routing, JSON in/out, error mapping
  library.ts  domain model: books, members, loans and fines (all rules live here)
  clock.ts    "now" resolution, incl. the X-Fake-Now header
  errors.ts   HttpError + helpers
  validate.ts request payload validation
test/       node:test suites (HTTP level + CLI integration), including fines.test.ts
client/     libctl, the Python 3 command line client
Dockerfile  two-stage image (small Node image, non-root user)
Makefile    test / run / docker
```

## Requirements

- Node.js 20.11 or newer (developed on Node 22)
- Python 3.9 or newer for the client
- Docker, only if you want the container image

## Run the service

```bash
npm install          # or: make install
npm run build        # or: make build
npm start            # or: make run   (listens on http://localhost:8080)
PORT=9000 make run   # choose another port
```

The service keeps everything in memory: restarting it resets all data.

## Run the tests

```bash
npm test             # or: make test
```

`npm test` compiles with `tsc` and runs the suites in `test/` with the built-in
`node:test` runner. The CLI tests run `client/libctl` against a live server and
are skipped automatically when `python3` is not on the `PATH`.

## Build and run the container

```bash
make docker                        # docker build -t library-service:latest .
docker run --rm -p 8080:8080 library-service:latest
```

The runtime image contains only Node plus the compiled `dist/` output and runs
as the non-root `node` user. `PORT` (default `8080`) is configurable.

## Use the client

`libctl` talks to the service over HTTP. The base URL comes from `--url` or the
`LIBRARY_URL` environment variable (default `http://localhost:8080`).

```bash
export LIBRARY_URL=http://localhost:8080

python3 client/libctl add-book --title Dune --author "Frank Herbert" --isbn 9780441013593 --copies 3 --tag scifi
python3 client/libctl search dune
python3 client/libctl search --tag sci-fi           # books carrying one tag
python3 client/libctl register-member --name "Ada Lovelace" --email ada@example.com
python3 client/libctl borrow --member <member-id> --book <book-id>
python3 client/libctl renew --loan <loan-id>
python3 client/libctl return --loan <loan-id>
python3 client/libctl overdue
python3 client/libctl history --member <member-id>
python3 client/libctl fines --member <member-id>
python3 client/libctl pay --member <member-id> --amount 1.25   # partial payment
python3 client/libctl pay --member <member-id>                 # settle everything
python3 client/libctl list-books           # extra convenience command
python3 client/libctl list-members         # extra convenience command
```

Every command prints a plain aligned table; `list-*`, `search` and `history`
print one row per record (`history` shows all loans of a member, newest first,
and book tables have a `TAGS` column). `add-book` takes `--tag` (repeatable)
and `search` accepts `--tag` on its own or combined with the text query.
Errors from the service are printed as a single line on stderr
(`error: <message> [CODE]`) and the exit code is non-zero. Add `--now <ISO-8601>`
to any command to simulate a date (it is sent as the `X-Fake-Now` header), for
example `python3 client/libctl overdue --now 2024-04-01T00:00:00Z`.

## HTTP API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | liveness probe |
| `GET` | `/books` | list books; filters: `q`, `title`, `author`, `isbn`, `tag` |
| `POST` | `/books` | add a book (`title`, `author`, `isbn`, optional `copies`, optional `tags`) |
| `GET` | `/books/{id}` | one book with availability |
| `DELETE` | `/books/{id}` | remove a book (refused while on loan) |
| `GET` | `/members` | list members |
| `POST` | `/members` | register a member (`name`, `email`) |
| `GET` | `/members/{id}` | one member |
| `GET` | `/members/{id}/loans` | loan history: all loans of the member, active and returned, newest first |
| `POST` | `/members/{id}/suspend` | suspend for `days` (default 7) or `until` |
| `POST` | `/members/{id}/unsuspend` | lift a suspension |
| `GET` | `/members/{id}/fines` | fine account of a member (`fines`, `totalOutstanding`, `overLimit`, ...) |
| `POST` | `/members/{id}/fines/pay` | pay fines: `amount` (optional) and/or `fineId` (optional) |
| `GET` | `/loans` | list loans; filters: `memberId`, `bookId`, `status` |
| `POST` | `/loans` | borrow (`memberId`, `bookId`) |
| `GET` | `/loans/overdue` | loans past their due date, most overdue first |
| `POST` | `/loans/{id}/renew` | renew once for 7 more days |
| `POST` | `/loans/{id}/return` | return a copy |

Collections are wrapped: `{"books": [...]}`, `{"members": [...]}`,
`{"loans": [...]}`. Errors are `{"error": "<message>", "code": "<CODE>"}` with
`400` (validation), `404` (unknown record), `405` (wrong method) or `409`
(business rule violated, e.g. `NO_COPIES`, `MEMBER_SUSPENDED`, `LOAN_LIMIT`,
`MEMBER_OVERDUE`, `BOOK_ON_LOAN`, `DUPLICATE_EMAIL`, `ALREADY_RENEWED`,
`ALREADY_RETURNED`, `LOAN_OVERDUE`, `FINE_LIMIT`, `NO_OUTSTANDING_FINES`).

A loan looks like:

```json
{
  "id": "…",
  "memberId": "…",
  "bookId": "…",
  "borrowedAt": "2024-03-01T09:00:00.000Z",
  "dueAt": "2024-03-15T09:00:00.000Z",
  "returnedAt": null,
  "renewals": 0,
  "status": "active",
  "daysOverdue": 0,
  "fine": null,
  "book": { "id": "…", "title": "Dune", "author": "Frank Herbert", "isbn": "9780441013593", "tags": ["scifi"] },
  "member": { "id": "…", "name": "Ada Lovelace", "email": "ada@example.com" }
}
```

## Business rules

**Tags.** A book carries a list of tags (`tags` in the request body and in every
book view, including the book summary inside a loan). Tags are normalized to
lower case, trimmed, de-duplicated and returned in that normalized form, so
`["SciFi", "scifi"]` becomes `["scifi"]`. A book may have at most 20 tags of at
most 40 characters each; anything else is a `400`. `GET /books?tag=<tag>` keeps
only the books carrying that tag, matched case-insensitively but exactly
(`scifi` does not match `sci-fi`), and combines with `q`, `title`, `author` and
`isbn`. Posting a book whose ISBN already exists still only adds copies, but
also merges the tags of the new payload into the existing record.

**Books.** ISBNs are unique and compared ignoring case, spaces and hyphens;
posting a book with a known ISBN increases `copiesOwned` instead of creating a
duplicate (`201` on create, `200` when copies were added). `copiesAvailable` is
`copiesOwned` minus the copies currently on loan. A book cannot be removed while
any copy is on loan (`409 BOOK_ON_LOAN`).

**Members.** Email addresses are unique and case-insensitive (stored
lower-cased). A suspended member cannot borrow, and can renew nothing either,
but may still return books.

**Loans.** A loan runs 14 days. Borrowing fails when no copy is available, the
member is suspended, the member already holds 5 active loans, or the member has
an overdue loan. A loan may be renewed once for 7 further days, unless it is
already overdue or the member is suspended. Returning a copy **more than 14 days
after its due date** suspends the member for 7 days from the return time
(exactly 14 days late does not).

**Loan history.** `GET /members/{id}/loans` returns every loan of that member,
active and returned, most recently borrowed first (ties broken by the later due
date). An unknown member yields `404 NOT_FOUND`.

**Fines.** A late return is charged `0.25` per day late (a return 3 days late
costs `0.75`; a return on the due date costs nothing). Fines are charged when
the book comes back, so an active loan that is already overdue only reports an
`accruing` amount in the member's fine account. A member whose **unpaid** fines
exceed `5.00` cannot borrow (`409 FINE_LIMIT`); exactly `5.00` still allows
borrowing. Fines can be paid fully (`POST /members/{id}/fines/pay` with an empty
body), partially (`{"amount": 1.25}`, refusing to overpay) or one at a time
(`{"fineId": "…"}`); without `fineId` payments settle the oldest fine first. The
fine account answers with `fines`, `totalCharged`, `totalPaid`,
`totalOutstanding`, `accruing`, `limit` and `overLimit`, and a loan carries the
`fine` that was charged for it (`null` when it was returned on time).

**Time travel.** Send an ISO-8601 date or date-time in the `X-Fake-Now` header
to make a request behave as if it happened at that moment; without the header
the wall clock is used. This is how the tests and demos simulate the passage of
time.
