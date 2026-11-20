# Library lending service

An HTTP JSON service for a small public library. It is written in TypeScript for Node.js with no web framework (plain `node:http`) and stores data in memory. Tests use the built-in `node:test` runner.

It manages books, members and loans. Details live in:
- books.md
- members.md
- loans.md

There is also a command line client, described in cli.md, and packaging rules in docs/packaging.md.
