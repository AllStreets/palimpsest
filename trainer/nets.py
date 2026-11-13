"""The school's small nets in MLX (Phase 4 Task 11, ruling 8).

Each net is one hidden layer of 16 units with exact GELU (`nn.gelu`, the erf form; never
`nn.gelu_approx`), trained with AdamW (lr 1e-2, weight decay 1e-2) for at most 300 full-batch
epochs, stopping early on the training rows' newest 15%, seeded. Features are standardised by
the fitted rows' (not the early-stop slice's) weighted mean and population std, so a row of weight
0 changes nothing; a constant column's std is 1.

Rows arrive as JSON lines, one per line, as the engine's `Row` from engine/school/datasets.ts:
{"id", "at", "x": [numbers], "y": number, "weight": number, "source": "real" | "distilled"}.

The weights file is JSON, read by shared/nets.ts with no Python:
{ net, version, features, norm: { mean, std }, layers: [{ W, b }, { W, b }], out }
where each W is MLX's own layout, one row per output unit (16 x d, then 1 x 16), and `out` is
"linear" for the appraiser's cost head and "sigmoid" for every other.

Both commands run on MLX's CPU stream. The nets are a few thousand weights over a few hundred
rows, so the CPU is quick, and on the GPU MLX's float32 matmul here was off by up to 7e-3 on an
8-column product, more than the 1e-5 the engine's own forward pass (shared/nets.ts) is held to.
"""
import json
import math
import os

import mlx.core as mx
import mlx.nn as nn
import mlx.optimizers as optim

NETS = ("appraiser-pass", "appraiser-cost", "router", "durability", "triage", "taste", "master")
HIDDEN = 16
EPOCHS = 300
LR = 1e-2
WEIGHT_DECAY = 1e-2
VAL_SHARE = 0.15
PATIENCE = 30
CHECKPOINT_EVERY = 50


def out_kind(net):
    return "linear" if net == "appraiser-cost" else "sigmoid"


class Mlp(nn.Module):
    def __init__(self, d, hidden=HIDDEN):
        super().__init__()
        self.hidden = nn.Linear(d, hidden)
        self.head = nn.Linear(hidden, 1)

    def __call__(self, z):
        return self.head(nn.gelu(self.hidden(z))).squeeze(-1)


def finite(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def read_rows(path):
    rows = []
    with open(path, "rb") as f:
        for n, raw in enumerate(f, 1):
            line = raw.decode("utf-8", errors="replace").strip()
            if not line:
                continue
            r = json.loads(line)
            if not isinstance(r, dict):
                raise ValueError(f"row {n} is not an object")
            x, y, w = r.get("x"), r.get("y"), r.get("weight", 1)
            if not isinstance(x, list) or not x or not all(finite(v) for v in x):
                raise ValueError(f"row {n}: x is a list of finite numbers")
            if not finite(y) or not finite(w) or w < 0:
                raise ValueError(f"row {n}: y and weight are finite numbers, weight not negative")
            if not isinstance(r.get("at"), str):
                raise ValueError(f"row {n}: at is a string")
            rows.append({"id": r.get("id"), "at": r["at"], "x": [float(v) for v in x], "y": float(y), "weight": float(w)})
    return rows


def standardiser(xs, ws):
    """Each column's weighted mean and population std; unweighted when every weight is 0."""
    if sum(ws) <= 0:
        ws = [1.0] * len(xs)
    total = sum(ws)
    d = len(xs[0])
    mean = [sum(w * x[j] for x, w in zip(xs, ws)) / total for j in range(d)]
    std = []
    for j in range(d):
        s = math.sqrt(sum(w * (x[j] - mean[j]) ** 2 for x, w in zip(xs, ws)) / total)
        std.append(s if s > 1e-12 else 1.0)
    return mean, std


def split(rows):
    """(fit, val): the rows by `at`, the newest round(15%) (at least one) held back to stop on."""
    rows = sorted(rows, key=lambda r: r["at"])
    n_val = max(1, round(len(rows) * VAL_SHARE))
    return rows[:-n_val], rows[-n_val:]


def standardise(xs, mean, std):
    return mx.array([[(x[j] - mean[j]) / std[j] for j in range(len(mean))] for x in xs], dtype=mx.float32)


def weights_json(net, version, features, mean, std, model):
    return {
        "net": net,
        "version": version,
        "features": features,
        "norm": {"mean": mean, "std": std},
        "layers": [
            {"W": model.hidden.weight.tolist(), "b": model.hidden.bias.tolist()},
            {"W": model.head.weight.tolist(), "b": model.head.bias.tolist()},
        ],
        "out": out_kind(net),
    }


def write_json(path, value):
    tmp = path + ".part"
    with open(tmp, "w") as f:
        json.dump(value, f)
    os.replace(tmp, path)


def train_net(request, stopping=lambda: False, progress=lambda step, of: None, saved=lambda step: None):
    with mx.stream(mx.cpu):
        return _train_net(request, stopping, progress, saved)


def _train_net(request, stopping, progress, saved):
    """Train `net` on the rows at `rows_path` and write its weights to `out_path`.

    Checkpoints the best weights so far every 50 epochs and at the end (each a `saved` line);
    when `stopping()` turns true between epochs, writes the best so far and answers stopped.
    """
    net = request.get("net")
    rows_path = request.get("rows_path")
    out_path = request.get("out_path")
    seed = request.get("seed", 1)
    version = request.get("version", 1)
    if net not in NETS:
        raise ValueError(f"unknown net: {net}")
    if not isinstance(rows_path, str) or not isinstance(out_path, str) or not out_path:
        raise ValueError("rows_path and out_path are paths")
    if not isinstance(seed, int) or isinstance(seed, bool):
        raise ValueError("seed is an integer")
    if not isinstance(version, int) or isinstance(version, bool) or version < 1:
        raise ValueError("version is a positive integer")

    rows = read_rows(rows_path)
    if len(rows) < 2:
        raise ValueError("a net needs at least 2 rows")
    d = len(rows[0]["x"])
    if any(len(r["x"]) != d for r in rows):
        raise ValueError("every row has the same number of columns")
    features = request.get("features")
    if features is None:
        features = [f"x{j}" for j in range(d)]
    if not isinstance(features, list) or len(features) != d or not all(isinstance(f, str) for f in features):
        raise ValueError(f"features names the {d} columns")
    linear = out_kind(net) == "linear"
    if not linear and any(r["y"] < 0 or r["y"] > 1 for r in rows):
        raise ValueError("a sigmoid head's labels are between 0 and 1")

    fit, val = split(rows)
    mean, std = standardiser([r["x"] for r in fit], [r["weight"] for r in fit])
    zf, zv = standardise([r["x"] for r in fit], mean, std), standardise([r["x"] for r in val], mean, std)
    yf, yv = mx.array([r["y"] for r in fit]), mx.array([r["y"] for r in val])
    wf, wv = mx.array([r["weight"] for r in fit]), mx.array([r["weight"] for r in val])

    mx.random.seed(seed)
    model = Mlp(d)
    mx.eval(model.parameters())
    optimizer = optim.AdamW(learning_rate=LR, weight_decay=WEIGHT_DECAY)

    def loss(m, z, y, w):
        o = m(z)
        per = (o - y) ** 2 if linear else nn.losses.binary_cross_entropy(o, y, with_logits=True, reduction="none")
        return (per * w).sum() / mx.maximum(w.sum(), 1e-12)

    step = nn.value_and_grad(model, loss)
    best = (math.inf, 0, None)

    last_saved = [None]

    def checkpoint(epoch):
        if last_saved[0] == epoch:
            return
        params = best[2] if best[2] is not None else model.parameters()
        keep = model.parameters()
        model.update(params)
        write_json(out_path, weights_json(net, version, features, mean, std, model))
        model.update(keep)
        last_saved[0] = epoch
        saved(epoch)

    def give_up(epoch):
        # weights that went to inf or NaN are no net: nothing this run wrote is left behind
        for path in (out_path, out_path + ".part"):
            if last_saved[0] is not None and os.path.exists(path):
                os.remove(path)
        raise ValueError(f"training went non-finite at epoch {epoch}; no weights written")

    epoch = 0
    stopped = False
    while epoch < EPOCHS:
        if stopping():
            stopped = True
            break
        t, grads = step(model, zf, yf, wf)
        optimizer.update(model, grads)
        epoch += 1
        v = loss(model, zv, yv, wv)
        mx.eval(model.parameters(), optimizer.state, t, v)
        v = v.item()
        if not (math.isfinite(t.item()) and math.isfinite(v)):
            give_up(epoch)
        if v < best[0]:
            # a copy of the arrays: MLX arrays are immutable, so the tree of references is enough
            best = (v, epoch, nn.utils.tree_map(lambda a: a, model.parameters()))
        if epoch % 10 == 0:
            progress(epoch, EPOCHS)
        if epoch - best[1] >= PATIENCE:
            break
        if epoch % CHECKPOINT_EVERY == 0:
            checkpoint(epoch)
    checkpoint(epoch)
    return {"epochs": epoch, "best_epoch": best[1], "val_loss": best[0] if math.isfinite(best[0]) else None, "rows": {"fit": len(fit), "val": len(val)}, "stopped": stopped}


def load(path):
    with open(path) as f:
        w = json.load(f)
    if not isinstance(w, dict) or w.get("out") not in ("sigmoid", "linear"):
        raise ValueError("not a net's weights")
    mean, std = w["norm"]["mean"], w["norm"]["std"]
    hidden, head = w["layers"]
    d = len(mean)
    h = len(hidden["b"])
    model = Mlp(d, h)
    model.update({
        "hidden": {"weight": mx.array(hidden["W"], dtype=mx.float32), "bias": mx.array(hidden["b"], dtype=mx.float32)},
        "head": {"weight": mx.array(head["W"], dtype=mx.float32), "bias": mx.array(head["b"], dtype=mx.float32)},
    })
    if model.hidden.weight.shape != (h, d) or model.head.weight.shape != (1, h) or len(std) != d or model.head.bias.shape != (1,):
        raise ValueError("the weights' shapes do not agree")
    return w, model


def predict_net(request):
    with mx.stream(mx.cpu):
        return _predict_net(request)


def _predict_net(request):
    """The net at `weights_path` on `x`: one row of raw features gives one number, a list of rows a list."""
    path = request.get("weights_path")
    x = request.get("x")
    if not isinstance(path, str):
        raise ValueError("weights_path is a path")
    w, model = load(path)
    batch = isinstance(x, list) and len(x) > 0 and isinstance(x[0], list)
    xs = x if batch else [x]
    d = len(w["norm"]["mean"])
    if not isinstance(xs, list) or not all(isinstance(r, list) and len(r) == d and all(finite(v) for v in r) for r in xs):
        raise ValueError(f"x is a row, or a list of rows, of {d} finite numbers")
    o = model(standardise(xs, w["norm"]["mean"], w["norm"]["std"]))
    if w["out"] == "sigmoid":
        o = mx.sigmoid(o)
    ys = o.tolist()
    return {"y": ys if batch else ys[0]}
