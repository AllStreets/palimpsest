/**
 * What runs where: the window, the engine on its port as a launchd agent,
 * its data folder, the children it starts under sandbox-exec, the two
 * things beside it (Ollama and gh), and the only ways off the Mac.
 */
import { DEFAULT_PORT, LAUNCHD_LABEL, OLLAMA_PORT, RESERVED_PORTS } from './data.js';
import { Sheet, type Diagram } from './sheet.js';

const W = 1600;
const H = 980;

export function machine(o: { enginePort?: number; ollamaPort?: number } = {}): Diagram {
  const enginePort = o.enginePort ?? DEFAULT_PORT;
  const ollamaPort = o.ollamaPort ?? OLLAMA_PORT;
  // The ports every child is refused, as the guard holds them, carried over to the ports drawn.
  const refused = RESERVED_PORTS.map((p) => (p === DEFAULT_PORT ? enginePort : p === OLLAMA_PORT ? ollamaPort : p));
  const s = new Sheet(W, H);

  s.text(80, 92, 'What runs where', { kind: 'title' });

  const A = { x: 80, w: 226 };
  const B = { x: 440, w: 300 };
  const C = { x: 870, w: 290 };
  const D = { x: 1270, w: 250 };
  const EDGE = 1215;
  const BUS = 805;
  const HEAD = 168;

  s.text(A.x, HEAD, 'On the screen', { kind: 'head' });
  s.text(B.x, HEAD, 'The engine', { kind: 'head' });
  s.text(C.x, HEAD, 'What it starts', { kind: 'head' });
  s.text(D.x, HEAD, 'Off the Mac', { kind: 'head' });
  s.line(80, HEAD + 18, W - 80, HEAD + 18, 'l-rule');

  // ------------------------------------------------------------ the window
  const R1 = 282;
  const app = s.entry(A.x, R1, A.w, 'Palimpsest.app', { note: 'The window: a splash, then the city the engine serves' });
  const browser = s.entry(A.x, R1 + 120, A.w, 'Any browser', { note: 'The same city at the same address' });

  // ------------------------------------------------------------ the engine
  const engine = s.entry(B.x, R1, B.w, 'The engine', {
    note: `A launchd user agent, ${LAUNCHD_LABEL}. It keeps running when the window is closed.`,
    keys: [`port:${enginePort}`],
  });
  s.line(A.x + A.w, app.rule, B.x, engine.rule, 'l-ink');
  s.arrow(B.x - 2, engine.rule, 0, 'l-ink', 6);
  s.text((A.x + A.w + B.x) / 2, app.rule - 9, `127.0.0.1:${enginePort}`, { kind: 'figure', anchor: 'middle', keys: [`port:${enginePort}`], cls: 't-accent' });
  const join = (A.x + A.w + B.x) / 2;
  s.path(`M${A.x + A.w},${browser.rule} H${join - 6} Q${join},${browser.rule} ${join},${browser.rule - 6} V${engine.rule}`, 'l-ink');

  s.text(B.x, 495, 'Its data folder', { kind: 'head' });
  const spine = B.x - 18;
  const folder = [
    s.entry(B.x, 540, B.w, 'SQLite', { note: 'The ledger, append only, and the tables it rebuilds' }),
    s.entry(B.x, 640, B.w, 'Mirrors', { note: 'A bare clone of each connected repo, kept by gh' }),
    s.entry(B.x, 740, B.w, 'Runs', { note: 'A fresh clone for each job, made without hardlinks, its push address broken on purpose' }),
  ];
  s.line(spine, engine.rule, spine, folder[folder.length - 1].rule, 'l-rule');
  s.line(spine, engine.rule, B.x, engine.rule, 'l-rule');
  for (const f of folder) s.line(spine, f.rule, B.x, f.rule, 'l-rule');

  // ------------------------------------------------------------ what it starts
  const kids = [
    { name: 'claude', note: 'The Claude CLI, under its own profile: file tools and one tool that hands commands to the broker', keys: ['child:claude'] },
    { name: 'Commands', note: 'Each one an agent asks for, through the broker, under the tool profile', keys: ['child:tool'] },
    { name: 'school.py', note: 'The trainer, under the trainer profile, with no network', keys: ['child:trainer'] },
    { name: 'mlx_lm.server', note: 'A graduate, served to the engine on a free loopback port', keys: ['child:mlx'] },
  ];
  const kidRows = kids.map((k, i) => {
    const y = R1 + i * 118;
    return { ...k, ...s.entry(C.x, y, C.w, k.name, { note: k.note, keys: k.keys, nameKind: 'node' }) };
  });

  const beside = [
    { name: 'Ollama', note: 'Its own service. The engine alone calls it, for the local firms', port: ollamaPort },
    { name: 'gh', note: 'The GitHub CLI, on his login. The engine alone runs it', port: null },
  ];
  const besideRows = beside.map((b, i) => ({ ...b, ...s.entry(C.x, 780 + i * 100, C.w, b.name, { note: b.note, keys: b.port ? [`port:${b.port}`] : ['child:gh'] }) }));

  // The bus: the engine starts or calls everything in the third column; nothing there calls back.
  s.line(B.x + B.w, engine.rule, BUS, engine.rule, 'l-ink');
  const ends = [...kidRows, ...besideRows].map((r) => r.rule);
  s.line(BUS, engine.rule, BUS, Math.max(...ends), 'l-ink');
  for (const y of ends) {
    s.line(BUS, y, C.x - 2, y, 'l-ink');
    s.arrow(C.x - 2, y, 0, 'l-ink', 6);
  }
  s.text((BUS + C.x) / 2 - 2, besideRows[0].rule - 9, String(ollamaPort), { kind: 'figure', anchor: 'middle', keys: [`port:${ollamaPort}`], cls: 't-accent' });

  // The refusal: no child reaches the engine's port or Ollama's.
  s.text(C.x, HEAD + 44, `Each under sandbox-exec. None can reach ${refused.map((p) => `127.0.0.1:${p}`).join(' or ')}, or another run.`, {
    kind: 'figure',
    keys: refused.map((p) => `refused:${p}`),
    wrap: C.w + 64,
    lineHeight: 17,
  });

  // ------------------------------------------------------------ the edge of the Mac
  s.line(EDGE, HEAD + 34, EDGE, H - 90, 'l-strong l-dash');
  const out = [
    { from: kidRows[0].rule, name: 'api.anthropic.com', note: 'While the agent works, through the run’s own proxy', keys: ['net:claude'] },
    { from: kidRows[1].rule, name: 'Package registries', note: 'While the run installs and works, through the same proxy. Never while the checks run', keys: ['net:registries'] },
    { from: besideRows[1].rule, name: 'GitHub', note: 'Issues, pull requests and the engine’s own pushes', keys: ['net:github'] },
  ];
  for (const o of out) {
    const e = s.entry(D.x, o.from - 11, D.w, o.name, { note: o.note, keys: o.keys, nameKind: 'node' });
    s.line(C.x + C.w, o.from, D.x - 2, e.rule, 'l-ink');
    s.arrow(D.x - 2, e.rule, 0, 'l-ink', 6);
    if (o.keys[0] !== 'net:github') {
      // The run's egress proxy sits on the edge.
      s.rect(EDGE - 5, o.from - 5, 10, 10, 'f-paper');
      s.raw(`<rect x="${EDGE - 5}" y="${o.from - 5}" width="10" height="10" class="ring"/>`);
    }
  }
  s.text(EDGE, kidRows[0].rule + 24, 'The run’s proxy', { kind: 'figure', anchor: 'middle', cls: 'halo' });
  // The trainer stops at the edge.
  const t = kidRows[2].rule;
  s.line(C.x + C.w, t, EDGE - 8, t, 'l-strong l-dash');
  s.line(EDGE - 8, t - 7, EDGE - 8, t + 7, 'l-stop');
  s.text(EDGE + 10, t + 5, 'No network', { kind: 'figure', cls: 't-stop' });

  s.text(80, H - 40, `Drawn from engine/server.ts, engine/launchd.ts, the sandbox's profiles and the guard's reserved ports.`, { kind: 'source' });

  return {
    name: 'machine',
    title: 'What runs where',
    alt: `What runs where. The app's window and any browser reach the engine at 127.0.0.1:${enginePort}. The engine is a launchd user agent with its data folder: SQLite and the ledger, the mirrors and the runs. It starts the claude CLI, the agents' commands, the trainer and a graduate's mlx_lm.server, each under sandbox-exec, and alone calls Ollama on ${ollamaPort} and gh. No child reaches the engine or Ollama. Only the run's proxy and gh leave the Mac.`,
    width: W,
    height: H,
    labels: s.labels,
    svg: s.svg(),
  };
}
