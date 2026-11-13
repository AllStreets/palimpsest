"""The school's trainer (Phase 4): one warm process the engine talks to in JSON lines.

Each request on stdin is one line, {"id": ..., "cmd": ..., ...}; each answer on stdout is one
line with the same id and "ok". Later tasks add train_net, predict_net, lora_train and
download_base. `school.py ping` answers once and exits, for the engine's setup check.

It runs under the trainer's sandbox profile with HF_HUB_OFFLINE=1; nothing here reaches the
network, and versions are read from package metadata, so a ping never starts the GPU.
"""
import importlib.metadata
import json
import platform
import sys


def version(dist):
    try:
        return importlib.metadata.version(dist)
    except importlib.metadata.PackageNotFoundError:
        return None


def ping(_request):
    return {"pong": True, "python": platform.python_version(), "arch": platform.machine(), "mlx": version("mlx"), "mlx_lm": version("mlx-lm")}


COMMANDS = {"ping": ping}


def answer(line):
    try:
        request = json.loads(line)
        if not isinstance(request, dict):
            raise ValueError("a request is a JSON object")
    except ValueError as e:
        return {"id": None, "ok": False, "error": f"not a request: {e}"}
    rid = request.get("id")
    command = COMMANDS.get(request.get("cmd"))
    if command is None:
        return {"id": rid, "ok": False, "error": f"unknown command: {request.get('cmd')}"}
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
    for line in sys.stdin:
        if line.strip():
            print(json.dumps(answer(line)), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
