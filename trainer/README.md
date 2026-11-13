# The trainer

The school trains its nets and LoRA adapters here, in a native arm64 Python with MLX. The engine starts `school.py` as one process, under its own sandbox profile, offline (`HF_HUB_OFFLINE=1`), and talks to it in JSON lines.

## Which Python

- `PALIMPSEST_PYTHON`, when set. While building, this is Beagle's venv, which already has the pinned versions: `PALIMPSEST_PYTHON=~/Downloads/beagle/trainer/.venv/bin/python`. Nothing is installed into it, and no bytecode is written.
- Otherwise `trainer/.venv/bin/python`, which only `npm run trainer:setup` makes.

`npm run trainer:setup` downloads Python 3.12 and the wheels in `requirements.txt` from PyPI through `uv`, then checks the result is arm64. It runs only when you run it, or say go (Decision 5).

## Checks

- Settings asks `school.py ping` for the Python version, the architecture and the mlx and mlx-lm versions. A Python that is not arm64, or has no mlx or mlx-lm, is named as the reason the trainer is not ready.
- `npm run test:trainer` runs `test_school.py` on the trainer's Python with a throwaway home. It prints "Skipped: no trainer Python" when there is none. It is never part of `npm test`.

## The nets

`train_net { net, rows_path, out_path, seed, features?, version? }` trains one small net (`nets.py`, ruling 8) on JSON lines of the engine's `Row` (`{ id, at, x, y, weight, source }`), writing a `{ "saved": epoch }` line at each checkpoint. `predict_net { weights_path, x }` runs a weights file on one row or a list of rows. Both run on MLX's CPU stream. The engine runs the same weights itself in `shared/nets.ts`; `test/fixtures/net-parity.json` holds the two to 1e-5 and is made once by `predict_net`, never by hand.
