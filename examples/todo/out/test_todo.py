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


if __name__ == "__main__":
    unittest.main()
