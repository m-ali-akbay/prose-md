# Todo CLI

A small command line todo app written in Python. Commands: add a task, list tasks, mark a task done. Tasks persist in a JSON file in the home directory.

Examples:
- Adding "buy milk" then listing shows "buy milk" as not done.

Also support a "remove" command to delete a task.

Also support a "clear" command that removes all tasks that are already done.

Tasks can have an optional due date (YYYY-MM-DD) given when adding. Listing shows the due date and sorts tasks with an earlier due date first; tasks without a due date come last.
