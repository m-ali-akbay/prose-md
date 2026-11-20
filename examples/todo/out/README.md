# Todo CLI

A small command line todo app written in Python. Tasks persist in a JSON file in
the home directory (`~/.todo.json`).

## Usage

```sh
python todo.py add "buy milk"
python todo.py add --due 2024-05-01 "buy milk"
python todo.py list
python todo.py done 1
python todo.py remove 1
python todo.py clear
```

`list` output marks done tasks with `[x]` and open ones with `[ ]`:

```
1. [ ] buy milk (due 2024-05-01)
2. [x] walk dog
```

Task ids are the 1-based positions shown by `list`.

### Due dates

`add --due YYYY-MM-DD <task>` attaches an optional due date to a task. The date
must be a real calendar date in exactly that form (`2024-02-30` or `2024-1-5`
are rejected with exit status `2`). `list` shows it as `(due YYYY-MM-DD)` and
sorts tasks by due date, earliest first; tasks without a due date come last and
tasks sharing a due date keep their insertion order. Because ids are positions
in the sorted listing, `done`/`remove` ids follow that order too.

- `done <id>` marks a task as done.
- `remove <id>` deletes a task; the remaining tasks keep their order, so ids
  shift down for tasks listed after the removed one.
- `clear` removes all tasks that are already done and prints how many were
  removed; open tasks keep their order (and are renumbered from 1).

Both `done` and `remove` exit with status `1` and an error message when the id
does not exist.

Use `--file PATH` (before the subcommand) to point at a different JSON store.

## Tests

```sh
python -m unittest -v
```
