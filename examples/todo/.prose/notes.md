Project: Todo CLI (Python, stdlib only). Spec: todo.md — "add / list / done / remove", tasks persist in a JSON file in home dir.

Files in out/:
- todo.py — CLI + library. Store default ~/.todo.json (env override via --file before subcommand).
  - Task model: {"text": str, "done": bool}; store is a JSON list, 1-based ids = list positions.
  - Functions: load_tasks(path), save_tasks(path) atomic via tempfile+os.replace, add_task, mark_done, remove_task (pop by id, order preserved so ids shift), format_tasks, build_parser, main(argv, path=None) returns exit code (0 ok, 1 unknown id, 2 bad input).
  - List format: "1. [ ] buy milk" / "1. [x] ..."; empty store -> "No tasks."
  - CLI messages: "Added: <text>", "Done: <text>", "Removed: <text>"; errors to stderr.
- test_todo.py — unittest suite (python -m unittest), tempdir store; includes remove tests.
- README.md — usage, remove semantics (ids shift), exit codes.

Decisions: no external deps, argparse, corrupt/missing store treated as empty. If more spec arrives (undo, priorities, due dates), extend the task dict and format_tasks; keep backward-compatible loads.
Pending: nothing.
