"""The trainer's own tests (Phase 4). Run by `npm run test:trainer`, never by `npm test`:
offline (HF_HUB_OFFLINE=1), on synthetic data under a temp dir, writing no bytecode."""
import importlib.metadata
import json
import math
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

    def test_a_zero_weight_row_has_no_effect(self):
        rows = synthetic_rows(120, seed=6)
        a, _ = self.train(rows, "a")
        # a row in the middle, labelled against the rule, weighing nothing; 121 rows still hold out the newest 18
        odd = {**rows[50], "id": "odd", "x": [-3.0, 4.0, -5.0], "y": 1, "weight": 0}
        b, _ = self.train(rows[:51] + [odd] + rows[51:], "b")
        with open(a) as fa, open(b) as fb:
            wa, wb = json.load(fa), json.load(fb)
        flat = lambda w: w["norm"]["mean"] + w["norm"]["std"] + [v for l in w["layers"] for row in l["W"] for v in row] + [v for l in w["layers"] for v in l["b"]]
        for p, q in zip(flat(wa), flat(wb)):
            self.assertAlmostEqual(p, q, delta=1e-5)

    def test_the_held_out_slice_is_the_newest_round_15_percent_of_rows(self):
        import nets

        for n in (10, 50, 120, 400):
            rows = synthetic_rows(n, seed=n)
            shuffled = list(rows)
            random.Random(1).shuffle(shuffled)
            fit, val = nets.split(shuffled)
            k = max(1, round(0.15 * n))
            self.assertEqual([r["id"] for r in val], [r["id"] for r in rows[n - k:]])
            self.assertEqual([r["id"] for r in fit], [r["id"] for r in rows[: n - k]])
        rows_path = os.path.join(self.tmp.name, "rows.jsonl")
        write_rows(rows_path, synthetic_rows(120, seed=2))
        reply = nets.train_net({"net": "taste", "rows_path": rows_path, "out_path": os.path.join(self.tmp.name, "w.json"), "seed": 1})
        self.assertEqual(reply["rows"], {"fit": 102, "val": 18})

    def test_best_epoch_is_within_the_run_and_the_written_weights_are_the_best(self):
        import nets

        rows = synthetic_rows(200, seed=9)
        for r in rows[::3]:
            r["y"] = 1 - r["y"]  # noisy labels, so the held-out loss turns and training stops early
        out_path, lines = self.train(rows, "best")
        reply = lines[-1]
        self.assertGreaterEqual(reply["best_epoch"], 1)
        self.assertLessEqual(reply["best_epoch"], reply["epochs"])
        if reply["epochs"] < 300:
            self.assertEqual(reply["epochs"] - reply["best_epoch"], nets.PATIENCE)
        _, val = nets.split([{**r, "x": [float(v) for v in r["x"]]} for r in rows])
        ys = self.run_school({"id": 2, "cmd": "predict_net", "weights_path": out_path, "x": [r["x"] for r in val]})[-1]["y"]
        bce = -sum(r["y"] * math.log(p) + (1 - r["y"]) * math.log(1 - p) for p, r in zip(ys, val)) / len(val)
        self.assertAlmostEqual(bce, reply["val_loss"], delta=1e-5)

    def test_a_checkpoint_on_the_last_epoch_is_saved_once(self):
        import nets

        rows_path = os.path.join(self.tmp.name, "rows.jsonl")
        write_rows(rows_path, synthetic_rows(60, seed=8))
        saves = []
        calls = [0]

        def stop_after_50():
            calls[0] += 1
            return calls[0] > 50

        reply = nets.train_net({"net": "taste", "rows_path": rows_path, "out_path": os.path.join(self.tmp.name, "w.json"), "seed": 1}, stopping=stop_after_50, saved=saves.append)
        if reply["epochs"] == 50:
            self.assertEqual(saves, [50])
        self.assertEqual(len(saves), len(set(saves)))

    def test_training_that_goes_non_finite_raises_and_writes_no_weights(self):
        rows = [{**r, "y": 1e30 * (1 + r["x"][0])} for r in synthetic_rows(60, seed=1)]
        rows_path = os.path.join(self.tmp.name, "huge.jsonl")
        out_path = os.path.join(self.tmp.name, "huge.json")
        write_rows(rows_path, rows)
        reply = self.run_school({"id": 1, "cmd": "train_net", "net": "appraiser-cost", "rows_path": rows_path, "out_path": out_path, "seed": 1})[-1]
        self.assertFalse(reply["ok"])
        self.assertIn("non-finite", reply["error"])
        self.assertFalse(os.path.exists(out_path))
        self.assertFalse(os.path.exists(out_path + ".part"))

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


def build_tiny_qwen(path, layers=2):
    """A random Qwen2-shaped model with `layers` layers and a byte-level tokenizer with a chat
    template, written from a config into `path`. Nothing is downloaded: every weight is random."""
    import mlx.core as mx
    from mlx.utils import tree_flatten
    from mlx_lm.models import qwen2
    from tokenizers import AddedToken, Tokenizer, decoders, models, pre_tokenizers

    os.makedirs(path, exist_ok=True)
    vocab = {c: i for i, c in enumerate(sorted(pre_tokenizers.ByteLevel.alphabet()))}
    specials = ["<|im_start|>", "<|im_end|>", "<|endoftext|>"]
    for s in specials:
        vocab[s] = len(vocab)
    tok = Tokenizer(models.BPE(vocab=vocab, merges=[]))
    tok.pre_tokenizer = pre_tokenizers.ByteLevel(add_prefix_space=False)
    tok.decoder = decoders.ByteLevel()
    tok.add_special_tokens([AddedToken(s, special=True) for s in specials])
    tok.save(os.path.join(path, "tokenizer.json"))
    template = (
        "{% for m in messages %}<|im_start|>{{ m['role'] }}\n{{ m['content'] }}<|im_end|>\n{% endfor %}"
        "{% if add_generation_prompt %}<|im_start|>assistant\n{% endif %}"
    )
    with open(os.path.join(path, "tokenizer_config.json"), "w") as f:
        json.dump({"tokenizer_class": "PreTrainedTokenizerFast", "eos_token": "<|im_end|>", "pad_token": "<|endoftext|>", "chat_template": template, "model_max_length": 4096}, f)
    config = {
        "model_type": "qwen2", "hidden_size": 64, "num_hidden_layers": layers, "intermediate_size": 128,
        "num_attention_heads": 4, "num_key_value_heads": 2, "rms_norm_eps": 1e-6, "vocab_size": 320,
        "rope_theta": 10000.0, "tie_word_embeddings": True, "max_position_embeddings": 4096,
    }
    with open(os.path.join(path, "config.json"), "w") as f:
        json.dump(config, f)
    mx.random.seed(0)
    model = qwen2.Model(qwen2.ModelArgs.from_dict(config))
    mx.save_safetensors(os.path.join(path, "model.safetensors"), dict(tree_flatten(model.parameters())))


def write_chats(path, n, seed):
    """`n` chats in the LoRA data shape (system, user, assistant), as the engine writes them."""
    rng = random.Random(seed)
    with open(path, "w") as f:
        for i in range(n):
            word = "".join(rng.choice("abcdef") for _ in range(6))
            messages = [
                {"role": "system", "content": "Reply with JSON only."},
                {"role": "user", "content": f"A change to acme/widgets was asked for:\nRename {word}.\n\nMake the change to the source."},
                {"role": "assistant", "content": json.dumps({"action": "answer", "answer": {"edits": [{"file": "src/a.ts", "find": word, "replace": word.upper()}]}})},
            ]
            f.write(json.dumps({"messages": messages}) + "\n")


class LoraTrain(unittest.TestCase):
    """lora_train on a tiny random Qwen-shaped model built here from a config; never a download."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = os.path.join(self.tmp.name, "base")
        self.data = os.path.join(self.tmp.name, "data")
        self.adapters = os.path.join(self.tmp.name, "adapters")
        build_tiny_qwen(self.base)
        os.makedirs(self.data)
        write_chats(os.path.join(self.data, "train.jsonl"), 8, 1)
        write_chats(os.path.join(self.data, "valid.jsonl"), 2, 2)

    def tearDown(self):
        self.tmp.cleanup()

    def args(self, iters, resume=False):
        a = [
            "--model", self.base, "--train", "--data", self.data,
            "--fine-tune-type", "lora", "--num-layers", "2", "--batch-size", "2", "--iters", str(iters),
            "--learning-rate", "1e-5", "--max-seq-length", "256", "--mask-prompt", "--grad-checkpoint",
            "--save-every", "2", "--adapter-path", self.adapters,
        ]
        if resume:
            a += ["--resume-adapter-file", os.path.join(self.adapters, "adapters.safetensors")]
        return a

    def run_lines(self, request):
        out = subprocess.run([sys.executable, SCHOOL], input=json.dumps(request) + "\n", capture_output=True, text=True, cwd=self.tmp.name, env=env(), timeout=300)
        self.assertEqual(out.returncode, 0, out.stderr)
        # stdout carries our JSON lines alone: mlx-lm's own report goes to stderr
        return [json.loads(l) for l in out.stdout.splitlines() if l.strip()]

    def test_lora_train_on_a_two_layer_random_qwen_shaped_model_built_from_a_config_writes_adapters_and_step_lines(self):
        lines = self.run_lines({"id": 3, "cmd": "lora_train", "args": self.args(4), "start": 0, "of": 4})
        reply = lines[-1]
        self.assertEqual(reply, {"id": 3, "ok": True, "step": 4, "of": 4, "stopped": False, "adapter": os.path.join(self.adapters, "adapters.safetensors")})
        self.assertEqual([l for l in lines if "step" in l and "ok" not in l], [{"id": 3, "step": s, "of": 4} for s in (1, 2, 3, 4)])
        self.assertEqual([l["saved"] for l in lines if "saved" in l], [2, 4])
        for name in ("adapters.safetensors", "0000002_adapters.safetensors", "0000004_adapters.safetensors", "adapter_config.json"):
            self.assertTrue(os.path.exists(os.path.join(self.adapters, name)), name)
        with open(os.path.join(self.adapters, "adapter_config.json")) as f:
            config = json.load(f)
        # what loading the adapter later needs to rebuild its layers
        self.assertEqual((config["fine_tune_type"], config["num_layers"], config["lora_parameters"]["rank"]), ("lora", 2, 8))

        # a resume from step 2 of 4 runs the remaining 2 from the saved adapter, counting on from 2
        again = self.run_lines({"id": 4, "cmd": "lora_train", "args": self.args(2, resume=True), "start": 2, "of": 4})
        self.assertEqual(again[-1]["ok"], True, again[-1])
        self.assertEqual(again[-1]["step"], 4)
        self.assertEqual([l["step"] for l in again if "step" in l and "ok" not in l], [3, 4])
        self.assertEqual([l["saved"] for l in again if "saved" in l], [4])

    def test_lora_train_on_sigterm_saves_the_step_it_reached_and_says_stopped(self):
        req = {"id": 7, "cmd": "lora_train", "args": self.args(100000), "start": 0, "of": 100000}
        p = subprocess.Popen([sys.executable, SCHOOL], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, cwd=self.tmp.name, env=env())
        try:
            p.stdin.write(json.dumps(req) + "\n")
            p.stdin.flush()
            first = json.loads(p.stdout.readline())
            self.assertEqual(first, {"id": 7, "step": 1, "of": 100000})
            p.send_signal(signal.SIGTERM)
            stdout, stderr = p.communicate(timeout=120)
        finally:
            if p.poll() is None:
                p.kill()
        self.assertEqual(p.returncode, 0, stderr)
        lines = [json.loads(l) for l in stdout.splitlines() if l.strip()]
        reply = lines[-1]
        self.assertTrue(reply["ok"], reply)
        self.assertTrue(reply["stopped"])
        self.assertLess(reply["step"], 100000)
        self.assertEqual(lines[-2], {"id": 7, "saved": reply["step"]}, "the step it stopped at is on disk")
        self.assertTrue(os.path.exists(os.path.join(self.adapters, "adapters.safetensors")))

    def test_lora_train_refuses_a_flag_the_engine_never_sends(self):
        for extra in (["--report-to", "wandb"], ["--config", "x.yaml"], ["--test"]):
            lines = self.run_lines({"id": 1, "cmd": "lora_train", "args": self.args(2) + extra, "start": 0, "of": 2})
            self.assertEqual(lines[-1]["ok"], False, extra)
            self.assertIn("not allowed", lines[-1]["error"])
        self.assertFalse(os.path.exists(os.path.join(self.adapters, "adapters.safetensors")))


class DownloadBase(unittest.TestCase):
    """download_base reaches the network only through the engine's proxy, so here it is only refused."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.tmp.cleanup()

    def test_download_base_refuses_offline_and_a_bad_repo_or_dir_and_reaches_nothing(self):
        dest = os.path.join(self.tmp.name, "base")
        requests = [
            {"id": 1, "cmd": "download_base", "repo": "mlx-community/Qwen2.5-Coder-7B-Instruct-4bit", "dir": dest},
            {"id": 2, "cmd": "download_base", "repo": "../etc", "dir": dest},
            {"id": 3, "cmd": "download_base", "repo": "mlx-community/Qwen2.5-Coder-7B-Instruct-4bit", "dir": "relative/base"},
        ]
        out = subprocess.run([sys.executable, SCHOOL], input="".join(json.dumps(r) + "\n" for r in requests), capture_output=True, text=True, cwd=self.tmp.name, env=env(), timeout=60)
        self.assertEqual(out.returncode, 0, out.stderr)
        replies = [json.loads(l) for l in out.stdout.splitlines() if l.strip()]
        self.assertEqual([r["ok"] for r in replies], [False, False, False])
        self.assertIn("HF_HUB_OFFLINE", replies[0]["error"])
        self.assertFalse(os.path.exists(dest))
