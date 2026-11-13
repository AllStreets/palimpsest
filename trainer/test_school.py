"""The trainer's own tests (Phase 4). Run by `npm run test:trainer`, never by `npm test`:
offline (HF_HUB_OFFLINE=1), on synthetic data under a temp dir, writing no bytecode."""
import importlib.metadata
import json
import os
import platform
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


if __name__ == "__main__":
    unittest.main()
