#!/usr/bin/env python3
"""Small command line todo app.

Tasks persist in a JSON file in the user's home directory (~/.todo.json).

Usage:
    todo.py add [--due YYYY-MM-DD] <task>
    todo.py list
    todo.py done <id>
    todo.py remove <id>
    todo.py clear
"""

import argparse
import datetime
import json
import os
import sys
import tempfile
from typing import Any, Dict, List, Optional

DATA_FILE = os.path.join(os.path.expanduser("~"), ".todo.json")
DUE_FORMAT = "%Y-%m-%d"


def parse_due(value: str) -> str:
    """Validate a due date given as YYYY-MM-DD and return it normalized.

    Raises ValueError if the value is not a real calendar date in that exact
    format (e.g. "2024-1-5" and "2024-02-30" are rejected).
    """
    try:
        parsed = datetime.datetime.strptime(value, DUE_FORMAT).date()
    except (TypeError, ValueError):
        raise ValueError(value)
    if parsed.isoformat() != value:
        raise ValueError(value)
    return parsed.isoformat()


def sort_tasks(tasks: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Order tasks by due date, earliest first, undated tasks last.

    The sort is stable, so tasks sharing a due date (or both having none) keep
    their stored insertion order.
    """
    return sorted(tasks, key=lambda task: (task.get("due") is None, task.get("due") or ""))


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
            due = entry.get("due")
            if due is not None:
                try:
                    due = parse_due(str(due))
                except ValueError:
                    due = None
            tasks.append(
                {
                    "text": str(entry["text"]),
                    "done": bool(entry.get("done", False)),
                    "due": due,
                }
            )
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


def add_task(text: str, path: str = DATA_FILE, due: Optional[str] = None) -> Dict[str, Any]:
    """Add a task (optionally with a YYYY-MM-DD due date) and return it.

    Tasks are stored in due-date order, so adding a task with an earlier due
    date moves it ahead of tasks that are due later.
    """
    if due is not None:
        due = parse_due(due)
    tasks = load_tasks(path)
    task = {"text": text, "done": False, "due": due}
    tasks.append(task)
    save_tasks(sort_tasks(tasks), path)
    return task


def mark_done(task_id: int, path: str = DATA_FILE) -> Dict[str, Any]:
    """Mark the task with the given 1-based id as done. Raises KeyError if absent."""
    tasks = sort_tasks(load_tasks(path))
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
    tasks = sort_tasks(load_tasks(path))
    if task_id < 1 or task_id > len(tasks):
        raise KeyError(task_id)
    removed = tasks.pop(task_id - 1)
    save_tasks(tasks, path)
    return removed


def clear_done(path: str = DATA_FILE) -> List[Dict[str, Any]]:
    """Remove all tasks that are already done and return them.

    Remaining (not done) tasks keep their stored order.
    """
    tasks = load_tasks(path)
    cleared = [task for task in tasks if task["done"]]
    remaining = [task for task in tasks if not task["done"]]
    if cleared:
        save_tasks(remaining, path)
    return cleared


def format_task(task: Dict[str, Any], index: int) -> str:
    """Render one task as '<id>. [x] <text> (due YYYY-MM-DD)'."""
    mark = "x" if task.get("done") else " "
    line = "%d. [%s] %s" % (index, mark, task["text"])
    if task.get("due"):
        line += " (due %s)" % task["due"]
    return line


def format_tasks(tasks: List[Dict[str, Any]]) -> str:
    """Render tasks sorted by due date, one line each, numbered from 1.

    Earlier due dates come first and tasks without a due date come last; tasks
    with the same due date keep their stored order.
    """
    if not tasks:
        return "No tasks."
    ordered = sort_tasks(tasks)
    return "\n".join(format_task(task, index) for index, task in enumerate(ordered, start=1))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="todo", description="A small command line todo app.")
    parser.add_argument(
        "--file",
        default=DATA_FILE,
        help="path to the JSON store (default: %(default)s)",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    add_parser = subparsers.add_parser("add", help="add a task")
    add_parser.add_argument(
        "--due",
        default=None,
        metavar="YYYY-MM-DD",
        help="optional due date (YYYY-MM-DD); listing sorts by it",
    )
    add_parser.add_argument("task", nargs="+", help="task text")

    subparsers.add_parser("list", help="list tasks")

    done_parser = subparsers.add_parser("done", help="mark a task done")
    done_parser.add_argument("id", type=int, help="task id as shown by 'list'")

    remove_parser = subparsers.add_parser("remove", help="delete a task")
    remove_parser.add_argument("id", type=int, help="task id as shown by 'list'")

    subparsers.add_parser("clear", help="remove all tasks that are already done")

    return parser


def main(argv=None, path: str = None) -> int:
    args = build_parser().parse_args(argv)
    store = path or args.file

    if args.command == "add":
        text = " ".join(args.task).strip()
        if not text:
            print("todo: task text must not be empty", file=sys.stderr)
            return 2
        try:
            task = add_task(text, store, due=args.due)
        except ValueError:
            print(
                "todo: invalid due date %r (expected YYYY-MM-DD)" % args.due,
                file=sys.stderr,
            )
            return 2
        added = task["text"]
        if task["due"]:
            added += " (due %s)" % task["due"]
        print("Added: %s" % added)
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

    if args.command == "clear":
        cleared = clear_done(store)
        print("Cleared %d task%s." % (len(cleared), "" if len(cleared) == 1 else "s"))
        return 0

    return 2


if __name__ == "__main__":
    sys.exit(main())
