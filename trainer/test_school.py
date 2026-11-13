"""The trainer's own tests (Phase 4). Run by `npm run test:trainer`, never by `npm test`:
offline (HF_HUB_OFFLINE=1), on synthetic data under a temp dir, writing no bytecode."""
import importlib.metadata
import json
import os
import platform
import random
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


PARITY = os.path.join(HERE, "..", "test", "fixtures", "net-parity.json")


def synthetic_rows(n, seed):
    """`n` rows of three standard normal columns, y = x0 > 0, an hour apart, oldest first."""
    rng = random.Random(seed)
    rows = []
    for i in range(n):
        x = [rng.gauss(0, 1), rng.gauss(0, 1), rng.gauss(0, 1)]
        at = f"2026-01-{1 + i // 24:02d}T{i % 24:02d}:00:00.000Z"
        rows.append({"id": f"r{i}", "at": at, "x": x, "y": 1 if x[0] > 0 else 0, "weight": 1, "source": "real"})
    return rows


def write_rows(path, rows):
    with open(path, "w") as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")


class Nets(unittest.TestCase):
    """`train_net` and `predict_net` (ruling 8): one hidden layer of exact GELU, standardised features."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.tmp.cleanup()

    def run_school(self, *requests):
        data = "".join(json.dumps(r) + "\n" for r in requests)
        out = subprocess.run([sys.executable, SCHOOL], input=data, capture_output=True, text=True, cwd=self.tmp.name, env=env(), timeout=300)
        self.assertEqual(out.returncode, 0, out.stderr)
        return [json.loads(l) for l in out.stdout.splitlines() if l.strip()]

    def train(self, rows, out_name, seed=1, **extra):
        rows_path = os.path.join(self.tmp.name, out_name + ".rows.jsonl")
        out_path = os.path.join(self.tmp.name, out_name + ".json")
        write_rows(rows_path, rows)
        lines = self.run_school({"id": 1, "cmd": "train_net", "net": "taste", "rows_path": rows_path, "out_path": out_path, "seed": seed, **extra})
        reply = lines[-1]
        self.assertTrue(reply["ok"], reply)
        return out_path, lines

    def test_train_net_learns_y_is_x0_above_0_on_400_synthetic_rows_to_held_out_brier_under_0_05(self):
        rows = synthetic_rows(400, seed=7)
        train, held = rows[:300], rows[300:]
        out_path, lines = self.train(train, "taste", features=["x0", "x1", "x2"])
        reply = lines[-1]
        self.assertFalse(reply["stopped"])
        self.assertLessEqual(reply["epochs"], 300)
        saves = [l["saved"] for l in lines if "saved" in l]
        self.assertGreaterEqual(len(saves), 1)
        self.assertEqual(saves[-1], reply["epochs"])
        with open(out_path) as f:
            weights = json.load(f)
        self.assertEqual(weights["net"], "taste")
        self.assertEqual(weights["version"], 1)
        self.assertEqual(weights["features"], ["x0", "x1", "x2"])
        self.assertEqual(weights["out"], "sigmoid")
        self.assertEqual([len(weights["layers"][0]["W"]), len(weights["layers"][0]["W"][0]), len(weights["layers"][0]["b"])], [16, 3, 16])
        self.assertEqual([len(weights["layers"][1]["W"]), len(weights["layers"][1]["W"][0]), len(weights["layers"][1]["b"])], [1, 16, 1])

        predicted = self.run_school({"id": 2, "cmd": "predict_net", "weights_path": out_path, "x": [r["x"] for r in held]})[-1]
        self.assertTrue(predicted["ok"], predicted)
        brier = sum((p - r["y"]) ** 2 for p, r in zip(predicted["y"], held)) / len(held)
        self.assertLess(brier, 0.05)

    def test_train_net_with_the_same_seed_writes_the_same_weights(self):
        rows = synthetic_rows(120, seed=3)
        a, _ = self.train(rows, "a")
        b, _ = self.train(rows, "b")
        with open(a) as fa, open(b) as fb:
            self.assertEqual(json.load(fa), json.load(fb))

    def test_the_cost_head_is_linear(self):
        rows = [{**r, "y": 2.0 * r["x"][0] + 1.0} for r in synthetic_rows(120, seed=4)]
        rows_path = os.path.join(self.tmp.name, "cost.jsonl")
        out_path = os.path.join(self.tmp.name, "cost.json")
        write_rows(rows_path, rows)
        reply = self.run_school({"id": 1, "cmd": "train_net", "net": "appraiser-cost", "rows_path": rows_path, "out_path": out_path, "seed": 1})[-1]
        self.assertTrue(reply["ok"], reply)
        with open(out_path) as f:
            self.assertEqual(json.load(f)["out"], "linear")
        y = self.run_school({"id": 2, "cmd": "predict_net", "weights_path": out_path, "x": [1.0, 0.0, 0.0]})[-1]["y"]
        self.assertAlmostEqual(y, 3.0, delta=0.5)

    def test_train_net_refuses_bad_requests_and_keeps_answering(self):
        rows_path = os.path.join(self.tmp.name, "rows.jsonl")
        write_rows(rows_path, synthetic_rows(20, seed=1))
        out_path = os.path.join(self.tmp.name, "w.json")
        replies = self.run_school(
            {"id": 1, "cmd": "train_net", "net": "oracle", "rows_path": rows_path, "out_path": out_path, "seed": 1},
            {"id": 2, "cmd": "train_net", "net": "taste", "rows_path": os.path.join(self.tmp.name, "none.jsonl"), "out_path": out_path, "seed": 1},
            {"id": 3, "cmd": "train_net", "net": "taste", "rows_path": rows_path, "out_path": out_path, "seed": 1, "features": ["only one"]},
            {"id": 4, "cmd": "predict_net", "weights_path": out_path, "x": [0, 0, 0]},
            {"id": 5, "cmd": "ping"},
        )
        self.assertEqual([r["ok"] for r in replies], [False, False, False, False, True])
        self.assertFalse(os.path.exists(out_path))

    def test_train_net_stopping_between_epochs_writes_the_best_so_far_and_says_stopped(self):
        import nets

        rows_path = os.path.join(self.tmp.name, "rows.jsonl")
        out_path = os.path.join(self.tmp.name, "w.json")
        write_rows(rows_path, synthetic_rows(120, seed=5))
        calls, saves = [0], []

        def stop_after_5():
            calls[0] += 1
            return calls[0] > 5

        reply = nets.train_net({"net": "taste", "rows_path": rows_path, "out_path": out_path, "seed": 1}, stopping=stop_after_5, saved=saves.append)
        self.assertTrue(reply["stopped"])
        self.assertEqual(reply["epochs"], 5)
        self.assertEqual(saves, [5])
        with open(out_path) as f:
            self.assertEqual(len(json.load(f)["layers"]), 2)

    def test_predict_net_reproduces_net_parity_json(self):
        with open(PARITY) as f:
            fixture = json.load(f)
        weights_path = os.path.join(self.tmp.name, "parity.json")
        with open(weights_path, "w") as f:
            json.dump(fixture["weights"], f)
        reply = self.run_school({"id": 1, "cmd": "predict_net", "weights_path": weights_path, "x": fixture["x"]})[-1]
        self.assertTrue(reply["ok"], reply)
        self.assertEqual(len(reply["y"]), 20)
        for got, want in zip(reply["y"], fixture["y"]):
            self.assertAlmostEqual(got, want, delta=1e-5)


if __name__ == "__main__":
    unittest.main()
