import os
import tempfile
import unittest

import todo


class TodoTests(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.tmpdir.name, ".todo.json")

    def tearDown(self):
        self.tmpdir.cleanup()

    def run_cli(self, *args):
        return todo.main(list(args), path=self.path)

    def test_add_then_list_shows_not_done(self):
        self.assertEqual(self.run_cli("add", "buy milk"), 0)
        tasks = todo.load_tasks(self.path)
        self.assertEqual(len(tasks), 1)
        self.assertEqual(tasks[0]["text"], "buy milk")
        self.assertFalse(tasks[0]["done"])
        self.assertEqual(todo.format_tasks(tasks), "1. [ ] buy milk")

    def test_list_empty(self):
        self.assertEqual(todo.format_tasks(todo.load_tasks(self.path)), "No tasks.")

    def test_mark_done(self):
        self.run_cli("add", "buy milk")
        self.run_cli("add", "walk dog")
        self.assertEqual(self.run_cli("done", "2"), 0)
        tasks = todo.load_tasks(self.path)
        self.assertEqual(todo.format_tasks(tasks), "1. [ ] buy milk\n2. [x] walk dog")

    def test_done_unknown_id(self):
        self.assertEqual(self.run_cli("done", "1"), 1)

    def test_multiword_task(self):
        self.run_cli("add", "buy", "oat", "milk")
        self.assertEqual(todo.load_tasks(self.path)[0]["text"], "buy oat milk")

    def test_persists_across_loads(self):
        todo.add_task("a", self.path)
        todo.save_tasks(todo.load_tasks(self.path), self.path)
        self.assertEqual([t["text"] for t in todo.load_tasks(self.path)], ["a"])

    def test_corrupt_file_treated_as_empty(self):
        with open(self.path, "w", encoding="utf-8") as fh:
            fh.write("not json")
        self.assertEqual(todo.load_tasks(self.path), [])

    def test_remove_task(self):
        self.run_cli("add", "buy milk")
        self.run_cli("add", "walk dog")
        self.run_cli("add", "write code")
        self.assertEqual(self.run_cli("remove", "2"), 0)
        tasks = todo.load_tasks(self.path)
        self.assertEqual([t["text"] for t in tasks], ["buy milk", "write code"])
        self.assertEqual(todo.format_tasks(tasks), "1. [ ] buy milk\n2. [ ] write code")

    def test_remove_keeps_done_state_of_other_tasks(self):
        self.run_cli("add", "buy milk")
        self.run_cli("add", "walk dog")
        self.run_cli("done", "1")
        self.assertEqual(self.run_cli("remove", "2"), 0)
        tasks = todo.load_tasks(self.path)
        self.assertEqual(todo.format_tasks(tasks), "1. [x] buy milk")

    def test_remove_unknown_id(self):
        self.assertEqual(self.run_cli("remove", "1"), 1)
        self.run_cli("add", "buy milk")
        self.assertEqual(self.run_cli("remove", "2"), 1)
        self.assertEqual(self.run_cli("remove", "0"), 1)
        self.assertEqual(len(todo.load_tasks(self.path)), 1)

    def test_remove_last_task_leaves_empty_store(self):
        self.run_cli("add", "buy milk")
        self.assertEqual(self.run_cli("remove", "1"), 0)
        self.assertEqual(todo.format_tasks(todo.load_tasks(self.path)), "No tasks.")

    def test_remove_task_function(self):
        todo.add_task("a", self.path)
        todo.add_task("b", self.path)
        removed = todo.remove_task(1, self.path)
        self.assertEqual(removed["text"], "a")
        self.assertEqual([t["text"] for t in todo.load_tasks(self.path)], ["b"])
        with self.assertRaises(KeyError):
            todo.remove_task(5, self.path)

    def test_clear_removes_only_done_tasks(self):
        self.run_cli("add", "buy milk")
        self.run_cli("add", "walk dog")
        self.run_cli("add", "write code")
        self.run_cli("done", "1")
        self.run_cli("done", "3")
        self.assertEqual(self.run_cli("clear"), 0)
        tasks = todo.load_tasks(self.path)
        self.assertEqual([t["text"] for t in tasks], ["walk dog"])
        self.assertEqual(todo.format_tasks(tasks), "1. [ ] walk dog")

    def test_clear_with_no_done_tasks_keeps_everything(self):
        self.run_cli("add", "buy milk")
        self.assertEqual(self.run_cli("clear"), 0)
        self.assertEqual([t["text"] for t in todo.load_tasks(self.path)], ["buy milk"])

    def test_clear_empty_store(self):
        self.assertEqual(self.run_cli("clear"), 0)
        self.assertEqual(todo.format_tasks(todo.load_tasks(self.path)), "No tasks.")

    def test_clear_after_done_shifts_ids(self):
        self.run_cli("add", "a")
        self.run_cli("add", "b")
        self.run_cli("done", "1")
        self.run_cli("clear")
        self.assertEqual(self.run_cli("remove", "1"), 0)
        self.assertEqual(todo.format_tasks(todo.load_tasks(self.path)), "No tasks.")

    def test_clear_done_function(self):
        todo.add_task("a", self.path)
        todo.add_task("b", self.path)
        todo.mark_done(2, self.path)
        cleared = todo.clear_done(self.path)
        self.assertEqual([t["text"] for t in cleared], ["b"])
        self.assertEqual([t["text"] for t in todo.load_tasks(self.path)], ["a"])

    def test_add_with_due_date(self):
        self.assertEqual(self.run_cli("add", "--due", "2024-05-01", "buy", "milk"), 0)
        tasks = todo.load_tasks(self.path)
        self.assertEqual(tasks[0]["text"], "buy milk")
        self.assertEqual(tasks[0]["due"], "2024-05-01")
        self.assertFalse(tasks[0]["done"])
        self.assertEqual(todo.format_tasks(tasks), "1. [ ] buy milk (due 2024-05-01)")

    def test_add_without_due_date_has_none(self):
        todo.add_task("buy milk", self.path)
        self.assertIsNone(todo.load_tasks(self.path)[0]["due"])

    def test_list_sorts_by_due_date_and_puts_undated_last(self):
        self.run_cli("add", "no date")
        self.run_cli("add", "--due", "2024-05-01", "later")
        self.run_cli("add", "--due", "2023-01-01", "earlier")
        self.run_cli("add", "--due", "2024-05-01", "same day as later")
        self.assertEqual(
            todo.format_tasks(todo.load_tasks(self.path)),
            "1. [ ] earlier (due 2023-01-01)\n"
            "2. [ ] later (due 2024-05-01)\n"
            "3. [ ] same day as later (due 2024-05-01)\n"
            "4. [ ] no date",
        )

    def test_ids_follow_listing_order(self):
        self.run_cli("add", "no date")
        self.run_cli("add", "--due", "2024-05-01", "later")
        self.run_cli("add", "--due", "2023-01-01", "earlier")
        self.assertEqual(self.run_cli("done", "1"), 0)
        tasks = todo.load_tasks(self.path)
        self.assertTrue([t for t in tasks if t["text"] == "earlier"][0]["done"])
        self.assertFalse([t for t in tasks if t["text"] == "later"][0]["done"])
        self.assertEqual(self.run_cli("remove", "1"), 0)
        self.assertEqual(
            [t["text"] for t in todo.load_tasks(self.path)], ["later", "no date"]
        )

    def test_invalid_due_date_rejected(self):
        self.assertEqual(self.run_cli("add", "--due", "2024-02-30", "bad"), 2)
        self.assertEqual(self.run_cli("add", "--due", "01/02/2024", "bad"), 2)
        self.assertEqual(self.run_cli("add", "--due", "2024-1-5", "bad"), 2)
        self.assertEqual(todo.load_tasks(self.path), [])

    def test_due_date_survives_done_and_clear(self):
        self.run_cli("add", "--due", "2024-05-01", "buy milk")
        self.run_cli("add", "walk dog")
        self.assertEqual(self.run_cli("done", "1"), 0)
        self.assertEqual(
            todo.format_tasks(todo.load_tasks(self.path)),
            "1. [x] buy milk (due 2024-05-01)\n2. [ ] walk dog",
        )
        self.run_cli("clear")
        self.assertEqual(
            todo.format_tasks(todo.load_tasks(self.path)), "1. [ ] walk dog"
        )

    def test_legacy_tasks_without_due_field_load(self):
        with open(self.path, "w", encoding="utf-8") as fh:
            fh.write('[{"text": "old", "done": false}]')
        self.assertEqual(todo.format_tasks(todo.load_tasks(self.path)), "1. [ ] old")
        self.assertIsNone(todo.load_tasks(self.path)[0]["due"])

    def test_parse_due_and_sort_helper(self):
        self.assertEqual(todo.parse_due("2024-05-01"), "2024-05-01")
        with self.assertRaises(ValueError):
            todo.parse_due("tomorrow")
        ordered = todo.sort_tasks(
            [
                {"text": "b", "done": False, "due": None},
                {"text": "a", "done": False, "due": "2024-01-01"},
            ]
        )
        self.assertEqual([t["text"] for t in ordered], ["a", "b"])


if __name__ == "__main__":
    unittest.main()
