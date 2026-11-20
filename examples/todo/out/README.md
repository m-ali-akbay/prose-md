# Todo CLI

A small command line todo app written in Python. Tasks persist in a JSON file in
the home directory (`~/.todo.json`).

## Usage

```sh
python todo.py add "buy milk"
python todo.py list
python todo.py done 1
python todo.py remove 1
```

`list` output marks done tasks with `[x]` and open ones with `[ ]`:

```
1. [ ] buy milk
2. [x] walk dog
```

Task ids are the 1-based positions shown by `list`.

- `done <id>` marks a task as done.
- `remove <id>` deletes a task; the remaining tasks keep their order, so ids
  shift down for tasks listed after the removed one.

Both `done` and `remove` exit with status `1` and an error message when the id
does not exist.

Use `--file PATH` (before the subcommand) to point at a different JSON store.

## Tests

```sh
python -m unittest -v
```
