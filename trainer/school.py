"""The school's trainer (Phase 4): one warm process the engine talks to in JSON lines.

Each request on stdin is one line, {"id": ..., "cmd": ..., ...}; each answer on stdout is one
line with the same id and "ok". train_net and predict_net run the small nets (nets.py);
lora_train fine-tunes the base model with mlx-lm (ruling 24); download_base fetches the base
model on his click. `school.py ping` answers once and exits, for the engine's setup check.

It runs under the trainer's sandbox profile with HF_HUB_OFFLINE=1; nothing here reaches the
network, and versions are read from package metadata, so a ping never starts the GPU. The one
exception is download_base, which the engine starts alone under a profile whose only network
allow is its egress proxy's loopback port, with HF_HUB_OFFLINE unset and HTTPS_PROXY set to it.

When the engine's gate closes (battery, warm, he is back) the engine sends SIGTERM and, ten
seconds later, SIGKILL. SIGTERM sets `STOPPING`; a long command checks `stopping()` between
steps, writes what it has, answers with "stopped": true, and the process exits 0 without
reading another request. Progress goes to stdout as {"id", "step", "of"} lines and each save as
{"id", "saved": step}, which is how the engine counts the steps a pause lost.
"""
import contextlib
import functools
import importlib.metadata
import json
import os
import platform
import re
import shutil
import signal
import sys
import time
import types

STOPPING = False


def stopping():
    return STOPPING


def on_sigterm(_signum, _frame):
    global STOPPING
    STOPPING = True


def progress(rid, step, of):
    print(json.dumps({"id": rid, "step": step, "of": of}), flush=True)


def saved(rid, step):
    print(json.dumps({"id": rid, "saved": step}), flush=True)


def version(dist):
    try:
        return importlib.metadata.version(dist)
    except importlib.metadata.PackageNotFoundError:
        return None


def ping(_request):
    return {"pong": True, "python": platform.python_version(), "arch": platform.machine(), "mlx": version("mlx"), "mlx_lm": version("mlx-lm")}


def sleep(request):
    """A test command: `steps` steps over `seconds`, a progress line each, the last step written to
    `out` (a JSON file in the school) at the end or on SIGTERM, which stops it between steps."""
    seconds = float(request.get("seconds", 1))
    steps = max(1, int(request.get("steps", 1)))
    out = request.get("out")
    step = 0
    while step < steps and not stopping():
        time.sleep(seconds / steps)
        step += 1
        progress(request.get("id"), step, steps)
    if isinstance(out, str) and out:
        tmp = out + ".part"
        with open(tmp, "w") as f:
            json.dump({"step": step, "of": steps}, f)
        os.replace(tmp, out)
        saved(request.get("id"), step)
    return {"step": step, "of": steps, "stopped": stopping()}


def train_net(request):
    """Train one small net (trainer/nets.py, ruling 8); a {"saved": epoch} line at each checkpoint."""
    import nets  # MLX loads only when a net is trained or run, never for a ping

    rid = request.get("id")
    return nets.train_net(request, stopping=stopping, progress=lambda step, of: progress(rid, step, of), saved=lambda step: saved(rid, step))


def predict_net(request):
    """A trained net's outputs on raw feature rows: the trainer's half of the parity check."""
    import nets

    return nets.predict_net(request)


# The flags the engine sends lora_train (ruling 24), and the ones a test may add; nothing else, so no
# request can turn on a report to a remote service or read a config file of its own.
LORA_FLAGS = {
    "--model": True, "--train": False, "--data": True, "--fine-tune-type": True, "--num-layers": True,
    "--batch-size": True, "--iters": True, "--learning-rate": True, "--max-seq-length": True,
    "--mask-prompt": False, "--grad-checkpoint": False, "--save-every": True, "--adapter-path": True,
    "--resume-adapter-file": True, "--seed": True, "--steps-per-eval": True, "--val-batches": True,
    "--steps-per-report": True,
}


def lora_args(argv):
    if not isinstance(argv, list) or not all(isinstance(a, str) for a in argv):
        raise ValueError("args is a list of strings")
    i = 0
    while i < len(argv):
        name = argv[i]
        if name not in LORA_FLAGS:
            raise ValueError(f"flag not allowed: {name}")
        i += 2 if LORA_FLAGS[name] else 1
    if i != len(argv):
        raise ValueError(f"flag without a value: {argv[-1]}")
    for needed in ("--model", "--data", "--adapter-path", "--iters", "--train"):
        if needed not in argv:
            raise ValueError(f"lora_train needs {needed}")


def lora_train(request):
    """Fine-tune with mlx-lm's own trainer, in this process (ruling 24).

    `args` is mlx_lm.lora's argv; `start` is the step the run resumes from (its adapter is
    `--resume-adapter-file`) and `of` the steps of the whole LoRA. Progress and saves are counted
    from `start`, so a resumed run reports the LoRA's own steps. A {"saved": step} line follows each
    checkpoint mlx-lm writes (every `--save-every` and at the end). On SIGTERM it stops between
    steps; mlx-lm then writes the adapter as it stands, so the step reached is saved, not lost.
    mlx-lm's own report goes to stderr: stdout is the engine's.
    """
    rid = request.get("id")
    argv = request.get("args")
    lora_args(argv)
    start = request.get("start", 0)
    of = request.get("of")
    if not isinstance(start, int) or start < 0:
        raise ValueError("start is a whole number")

    import mlx_lm.lora as lora
    from mlx_lm.tuner import trainer

    args = vars(lora.build_parser().parse_args(argv))
    for k, v in lora.CONFIG_DEFAULTS.items():
        if args.get(k) is None:
            args[k] = v
    iters = int(args["iters"])
    save_every = int(args["save_every"])
    if not isinstance(of, int) or of < start + iters:
        raise ValueError("of is at least start plus --iters")
    out = sys.stdout
    done = [0]
    last_saved = [None]

    def line(obj):
        print(json.dumps(obj), file=out, flush=True)

    def note_saved(k):
        if last_saved[0] != k:
            last_saved[0] = k
            line({"id": rid, "saved": start + k})

    def batches(*a, **kw):
        # the validation passes read batches too, without loop: those are not steps
        if not kw.get("loop"):
            yield from trainer.iterate_batches(*a, **kw)
            return
        # Asked for batch k+1 only once step k (and its save, if due) is done. A batch handed out
        # is always trained on: the stop is read before it, never after.
        for batch in trainer.iterate_batches(*a, **kw):
            if done[0] > 0:
                line({"id": rid, "step": start + done[0], "of": of})
                if done[0] % save_every == 0:
                    note_saved(done[0])
            if stopping():
                return
            done[0] += 1
            yield batch

    real_train = lora.train
    lora.train = functools.partial(trainer.train, iterate_batches=batches)
    try:
        with contextlib.redirect_stdout(sys.stderr):
            lora.run(types.SimpleNamespace(**args))
    finally:
        lora.train = real_train
    # zip() stops on the last step without asking for another batch: its line is written here
    if done[0] > 0 and done[0] == iters:
        line({"id": rid, "step": start + done[0], "of": of})
    # mlx-lm writes adapters.safetensors once more as it ends, the step reached
    note_saved(done[0])
    adapter = os.path.join(args["adapter_path"], "adapters.safetensors")
    return {"step": start + done[0], "of": of, "stopped": stopping(), "adapter": adapter}


HF_REPO = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*$")


def download_base(request):
    """The base model, on his click only (Decision 6): snapshot_download into `dir`/.part, moved
    into `dir` only once it is complete, so a half download is never taken for the model and the
    next click resumes it from the files already there. Never with his login (token=False,
    and the engine sets HF_TOKEN empty), never over xet (HF_HUB_DISABLE_XET=1), and only through
    the engine's proxy (HTTPS_PROXY), which allows the Hugging Face hosts alone."""
    repo = request.get("repo")
    dest = request.get("dir")
    if not isinstance(repo, str) or not HF_REPO.match(repo) or ".." in repo:
        raise ValueError("repo is a Hugging Face model name")
    if not isinstance(dest, str) or not os.path.isabs(dest):
        raise ValueError("dir is an absolute path")
    if os.environ.get("HF_HUB_OFFLINE"):
        raise RuntimeError("HF_HUB_OFFLINE is set: only the engine's download command may reach the network")
    from huggingface_hub import snapshot_download

    part = os.path.join(dest, ".part")
    os.makedirs(part, exist_ok=True)
    with contextlib.redirect_stdout(sys.stderr):
        snapshot_download(repo_id=repo, local_dir=part, token=False)
    if not os.path.exists(os.path.join(part, "config.json")):
        raise RuntimeError("the download has no config.json")
    # the hub's bookkeeping for resuming stays behind; config.json goes in last, as it is what says ready
    shutil.rmtree(os.path.join(part, ".cache"), ignore_errors=True)
    names = sorted(os.listdir(part), key=lambda n: n == "config.json")
    for name in names:
        target = os.path.join(dest, name)
        if os.path.isdir(target) and not os.path.islink(target):
            shutil.rmtree(target)
        os.replace(os.path.join(part, name), target)
    os.rmdir(part)
    return {"dir": dest}


COMMANDS = {"ping": ping, "sleep": sleep, "train_net": train_net, "predict_net": predict_net, "lora_train": lora_train, "download_base": download_base}


def answer(line):
    # a line that is not JSON, nests too deep to read, or is not an object is answered, never fatal
    try:
        request = json.loads(line)
        if not isinstance(request, dict):
            raise ValueError("a request is a JSON object")
    except (ValueError, RecursionError) as e:
        return {"id": None, "ok": False, "error": f"not a request: {type(e).__name__}"}
    rid = request.get("id")
    cmd = request.get("cmd")
    if not isinstance(cmd, str):
        return {"id": rid, "ok": False, "error": "a request's cmd is a string"}
    command = COMMANDS.get(cmd)
    if command is None:
        return {"id": rid, "ok": False, "error": f"unknown command: {cmd}"}
    try:
        return {"id": rid, "ok": True, **command(request)}
    except Exception as e:  # one failed request never ends the process
        return {"id": rid, "ok": False, "error": f"{type(e).__name__}: {e}"}


def main(argv):
    if argv[1:] == ["ping"]:
        print(json.dumps(ping({})), flush=True)
        return 0
    if argv[1:]:
        print("usage: school.py [ping]", file=sys.stderr)
        return 2
    signal.signal(signal.SIGTERM, on_sigterm)
    # bytes, decoded line by line, so a line that is not UTF-8 is answered rather than ending the loop
    for raw in sys.stdin.buffer:
        line = raw.decode("utf-8", errors="replace")
        if line.strip():
            print(json.dumps(answer(line)), flush=True)
        if stopping():
            return 0
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
