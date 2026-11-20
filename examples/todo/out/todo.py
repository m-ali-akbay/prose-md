#!/usr/bin/env python3
"""Small command line todo app.

Tasks persist in a JSON file in the user's home directory (~/.todo.json).

Usage:
    todo.py add <task>
    todo.py list
    todo.py done <id>
    todo.py remove <id>
"""

import argparse
import json
import os
import sys
import tempfile
from typing import Any, Dict, List

DATA_FILE = os.path.join(os.path.expanduser("~"), ".todo.json")


def load_tasks(path: str = DATA_FILE) -> List[Dict[str, Any]]:
    """Load tasks from the JSON store, returning an empty list if missing."""
    if not os.path.exists(path):
        return []
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return []
    if not isinstance(data, list):
        return []
    tasks: List[Dict[str, Any]] = []
    for entry in data:
        if isinstance(entry, dict) and "text" in entry:
            tasks.append({"text": str(entry["text"]), "done": bool(entry.get("done", False))})
    return tasks


def save_tasks(tasks: List[Dict[str, Any]], path: str = DATA_FILE) -> None:
    """Atomically write tasks to the JSON store."""
    directory = os.path.dirname(os.path.abspath(path)) or "."
    os.makedirs(directory, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(dir=directory, prefix=".todo-", suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(tasks, fh, indent=2)
            fh.write("\n")
        os.replace(tmp_path, path)
    except OSError:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)
        raise


def add_task(text: str, path: str = DATA_FILE) -> Dict[str, Any]:
    """Add a task and return it."""
    tasks = load_tasks(path)
    task = {"text": text, "done": False}
    tasks.append(task)
    save_tasks(tasks, path)
    return task


def mark_done(task_id: int, path: str = DATA_FILE) -> Dict[str, Any]:
    """Mark the task with the given 1-based id as done. Raises KeyError if absent."""
    tasks = load_tasks(path)
    if task_id < 1 or task_id > len(tasks):
        raise KeyError(task_id)
    tasks[task_id - 1]["done"] = True
    save_tasks(tasks, path)
    return tasks[task_id - 1]


def remove_task(task_id: int, path: str = DATA_FILE) -> Dict[str, Any]:
    """Delete the task with the given 1-based id. Raises KeyError if absent.

    Remaining tasks keep their stored order, so ids shift down by one for the
    tasks that followed the removed one.
    """
    tasks = load_tasks(path)
    if task_id < 1 or task_id > len(tasks):
        raise KeyError(task_id)
    removed = tasks.pop(task_id - 1)
    save_tasks(tasks, path)
    return removed


def format_tasks(tasks: List[Dict[str, Any]]) -> str:
    """Render tasks as one line each: '<id>. [x] <text>' or '<id>. [ ] <text>'."""
    if not tasks:
        return "No tasks."
    lines = []
    for index, task in enumerate(tasks, start=1):
        mark = "x" if task["done"] else " "
        lines.append("%d. [%s] %s" % (index, mark, task["text"]))
    return "\n".join(lines)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="todo", description="A small command line todo app.")
    parser.add_argument(
        "--file",
        default=DATA_FILE,
        help="path to the JSON store (default: %(default)s)",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    add_parser = subparsers.add_parser("add", help="add a task")
    add_parser.add_argument("task", nargs="+", help="task text")

    subparsers.add_parser("list", help="list tasks")

    done_parser = subparsers.add_parser("done", help="mark a task done")
    done_parser.add_argument("id", type=int, help="task id as shown by 'list'")

    remove_parser = subparsers.add_parser("remove", help="delete a task")
    remove_parser.add_argument("id", type=int, help="task id as shown by 'list'")

    return parser


def main(argv=None, path: str = None) -> int:
    args = build_parser().parse_args(argv)
    store = path or args.file

    if args.command == "add":
        text = " ".join(args.task).strip()
        if not text:
            print("todo: task text must not be empty", file=sys.stderr)
            return 2
        task = add_task(text, store)
        print("Added: %s" % task["text"])
        return 0

    if args.command == "list":
        print(format_tasks(load_tasks(store)))
        return 0

    if args.command == "done":
        try:
            task = mark_done(args.id, store)
        except KeyError:
            print("todo: no task with id %d" % args.id, file=sys.stderr)
            return 1
        print("Done: %s" % task["text"])
        return 0

    if args.command == "remove":
        try:
            task = remove_task(args.id, store)
        except KeyError:
            print("todo: no task with id %d" % args.id, file=sys.stderr)
            return 1
        print("Removed: %s" % task["text"])
        return 0

    return 2


if __name__ == "__main__":
    sys.exit(main())
