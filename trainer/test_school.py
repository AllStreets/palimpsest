"""The trainer's own tests (Phase 4). Run by `npm run test:trainer`, never by `npm test`:
offline (HF_HUB_OFFLINE=1), on synthetic data under a temp dir, writing no bytecode."""
import importlib.metadata
import json
import os
import platform
import signal
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCHOOL = os.path.join(HERE, "school.py")


def version(dist):
    try:
        return importlib.metadata.version(dist)
    except importlib.metadata.PackageNotFoundError:
        return None


def env():
    with_offline = dict(os.environ)
    with_offline.update({"HF_HUB_OFFLINE": "1", "PYTHONDONTWRITEBYTECODE": "1"})
    return with_offline


class Ping(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.tmp.cleanup()

    def expected(self):
        return {"pong": True, "python": platform.python_version(), "arch": platform.machine(), "mlx": version("mlx"), "mlx_lm": version("mlx-lm")}

    def test_ping_answers_pong_with_the_versions(self):
        out = subprocess.run([sys.executable, SCHOOL, "ping"], capture_output=True, text=True, cwd=self.tmp.name, env=env(), timeout=60)
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertEqual(json.loads(out.stdout), self.expected())

    def test_the_line_loop_answers_each_request_by_its_id_and_refuses_an_unknown_one(self):
        lines = "\n".join([json.dumps({"id": 1, "cmd": "ping"}), "not json", json.dumps({"id": 2, "cmd": "fly"})]) + "\n"
        out = subprocess.run([sys.executable, SCHOOL], input=lines, capture_output=True, text=True, cwd=self.tmp.name, env=env(), timeout=60)
        self.assertEqual(out.returncode, 0, out.stderr)
        replies = [json.loads(l) for l in out.stdout.splitlines() if l.strip()]
        self.assertEqual(replies[0], {"id": 1, "ok": True, **self.expected()})
        self.assertEqual(replies[1]["ok"], False)
        self.assertIsNone(replies[1]["id"])
        self.assertEqual(replies[2], {"id": 2, "ok": False, "error": "unknown command: fly"})
        self.assertEqual(len(replies), 3)

    def loop(self, data):
        out = subprocess.run([sys.executable, SCHOOL], input=data, capture_output=True, cwd=self.tmp.name, env=env(), timeout=60)
        self.assertEqual(out.returncode, 0, out.stderr.decode("utf-8", "replace"))
        return [json.loads(l) for l in out.stdout.decode("utf-8").splitlines() if l.strip()]

    def test_bad_input_gets_an_error_reply_and_the_process_keeps_answering(self):
        nested = "[" * 100_000 + "]" * 100_000
        data = b"\n".join([
            json.dumps({"id": 1, "cmd": []}).encode(),
            json.dumps({"id": 2, "cmd": {"a": 1}}).encode(),
            nested.encode(),
            b'{"id": 3, "cmd": "\xff\xfe"}',
            b"\xff\xfe not even json",
            json.dumps({"id": 4, "cmd": "ping"}).encode(),
        ]) + b"\n"
        replies = self.loop(data)
        self.assertEqual(len(replies), 6)
        for r in replies[:5]:
            self.assertEqual(r["ok"], False, r)
            self.assertIn("error", r)
        self.assertEqual(replies[0]["id"], 1)
        self.assertEqual(replies[1]["id"], 2)
        self.assertEqual(replies[3]["id"], 3)
        self.assertEqual(replies[5], {"id": 4, "ok": True, **self.expected()})


class Sleep(unittest.TestCase):
    """The `sleep` test command: steps it reports as it goes, and what it does when the engine's gate closes."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.tmp.cleanup()

    def test_sleep_reports_each_step_and_saves_the_last(self):
        out_path = os.path.join(self.tmp.name, "last.json")
        req = json.dumps({"id": 5, "cmd": "sleep", "seconds": 0.2, "steps": 2, "out": out_path}) + "\n"
        out = subprocess.run([sys.executable, SCHOOL], input=req, capture_output=True, text=True, cwd=self.tmp.name, env=env(), timeout=60)
        self.assertEqual(out.returncode, 0, out.stderr)
        lines = [json.loads(l) for l in out.stdout.splitlines() if l.strip()]
        self.assertEqual(lines[0], {"id": 5, "step": 1, "of": 2})
        self.assertEqual(lines[1], {"id": 5, "step": 2, "of": 2})
        self.assertEqual(lines[2], {"id": 5, "saved": 2})
        self.assertEqual(lines[3], {"id": 5, "ok": True, "step": 2, "of": 2, "stopped": False})
        with open(out_path) as f:
            self.assertEqual(json.load(f), {"step": 2, "of": 2})

    def test_school_py_on_sigterm_writes_its_last_step_and_exits_0(self):
        out_path = os.path.join(self.tmp.name, "last.json")
        req = json.dumps({"id": 9, "cmd": "sleep", "seconds": 60, "steps": 600, "out": out_path}) + "\n"
        p = subprocess.Popen([sys.executable, SCHOOL], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, cwd=self.tmp.name, env=env())
        try:
            p.stdin.write(req)
            p.stdin.flush()
            first = json.loads(p.stdout.readline())
            self.assertEqual(first, {"id": 9, "step": 1, "of": 600})
            p.send_signal(signal.SIGTERM)
            stdout, stderr = p.communicate(timeout=20)
        finally:
            if p.poll() is None:
                p.kill()
        self.assertEqual(p.returncode, 0, stderr)
        lines = [json.loads(l) for l in stdout.splitlines() if l.strip()]
        reply = lines[-1]
        self.assertEqual(reply["id"], 9)
        self.assertTrue(reply["ok"])
        self.assertTrue(reply["stopped"])
        self.assertGreaterEqual(reply["step"], 1)
        self.assertLess(reply["step"], 600)
        self.assertEqual(lines[-2], {"id": 9, "saved": reply["step"]})
        with open(out_path) as f:
            self.assertEqual(json.load(f), {"step": reply["step"], "of": 600})


if __name__ == "__main__":
    unittest.main()
