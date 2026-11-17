/**
 * The path one command takes from an agent to the repo and the network,
 * and what each layer on that path refuses: the never list in the agent's
 * instructions, the claude process's own profile, the broker and its
 * guard, the tool profile, and the run's egress proxy, stage by stage.
 */
import type { EgressStage } from '../../engine/market/egress.js';
import { EGRESS_EXAMPLE, EGRESS_STAGE_LABEL, EGRESS_STAGES, egressHosts, GUARD_LABEL, neverList, SECRETS } from './data.js';
import { Sheet, type Diagram } from './sheet.js';

const W = 1600;
const H = 860;
const PATH_Y = 196;

export function sandbox(): Diagram {
  const s = new Sheet(W, H);
  s.text(80, 92, 'The path of one command', { kind: 'title' });

  const cols = [80, 384, 688, 1022, 1326];
  const colW = 270;
  const GATE = 20;
  const GATE_TOP = PATH_Y - 26;
  const GATE_BOTTOM = H - 92;

  // The command's path: one line through every layer, ending in the run's folder.
  s.line(cols[0], PATH_Y, W - 80, PATH_Y, 'l-accent');
  s.arrow(W - 80, PATH_Y, 0, 'l-accent', 7);
  s.text(cols[0], PATH_Y - 14, 'A command an agent wants to run', { kind: 'figure', cls: 't-accent' });
  s.text(W - 80, PATH_Y - 14, 'The repo, and only the hosts its stage allows', { kind: 'figure', anchor: 'end', cls: 't-accent' });

  // The gates between layers.
  for (const x of cols.slice(1)) {
    s.line(x - GATE, GATE_TOP, x - GATE, GATE_BOTTOM, 'l-rule');
    s.rect(x - GATE - 4, PATH_Y - 4, 8, 8, 'f-paper');
    s.raw(`<rect x="${x - GATE - 4}" y="${PATH_Y - 4}" width="8" height="8" class="ring-accent"/>`);
  }

  const HEAD = PATH_Y + 52;
  const head = (i: number, name: string, under: string, keys: string[] = []) => {
    s.text(cols[i], HEAD, name, { kind: 'node', keys });
    s.text(cols[i], HEAD + 24, under, { kind: 'figure' });
  };
  const list = (i: number, y: number, items: Array<{ text: string; keys?: string[]; kind?: 'note' | 'code' }>, gap = 22, wrap = 0) => {
    let yy = y;
    for (const it of items) {
      s.line(cols[i], yy - 5, cols[i] + 8, yy - 5, 'l-strong');
      const n = s.text(cols[i] + 16, yy, it.text, { kind: it.kind ?? 'note', keys: it.keys, wrap: wrap || undefined, lineHeight: 18 });
      yy += gap + (n - 1) * 18;
    }
    return yy;
  };

  // 1. The instructions.
  head(0, 'The never list', 'In every agent’s instructions');
  s.text(cols[0], HEAD + 64, 'Never, without asking:', { kind: 'note' });
  const never = neverList();
  list(0, HEAD + 92, never.map((t) => ({ text: t, keys: ['never'] })), 24, 240);

  // 2. The claude process.
  head(1, 'The claude process', 'Under the CLI profile', ['profile:cli']);
  s.text(cols[1], HEAD + 64, 'No shell. File tools that stay inside the repo, and one tool that hands a command to the broker. It finds its own login, and cannot write Claude’s settings.', {
    kind: 'note',
    wrap: colW - 10,
    lineHeight: 20,
  });
  s.text(cols[1], HEAD + 194, 'A local model’s tool loop runs in the engine and calls the broker the same way.', { kind: 'note', wrap: colW - 10, lineHeight: 20, cls: 't-dim' });

  // 3. The broker and its guard.
  head(2, 'The broker', 'Checks the guard, then runs it');
  s.text(cols[2], HEAD + 64, 'In the run’s own folder, with an environment built from nothing. The guard refuses:', { kind: 'note', wrap: colW - 10, lineHeight: 20 });
  const guard = (Object.keys(GUARD_LABEL) as Array<keyof typeof GUARD_LABEL>).filter((k) => GUARD_LABEL[k] !== null);
  const guardEnd = list(2, HEAD + 128, guard.map((k) => ({ text: GUARD_LABEL[k]!, keys: [`guard:${k}`] })), 21);

  // 4. The tool profile.
  head(3, 'The tool profile', 'sandbox-exec, deny by default', ['profile:tool']);
  s.text(cols[3], HEAD + 64, 'Writes only the run’s own folders. The repo’s .git is read only, and a hard link out is refused. It cannot read:', { kind: 'note', wrap: colW - 10, lineHeight: 20 });
  list(3, HEAD + 148, SECRETS.map((p) => ({ text: p, kind: 'code' as const, keys: ['secret'] })), 20);

  // 5. The proxy, stage by stage.
  head(4, 'The run’s proxy', 'What each stage may reach');
  const hosts = egressHosts();
  let y = HEAD + 64;
  for (const st of EGRESS_STAGES) {
    s.text(cols[4], y, EGRESS_STAGE_LABEL[st as EgressStage], { kind: 'small', keys: [`egress:${st}`] });
    y += 24;
    const hs = hosts[st];
    if (hs.length === 0) {
      s.text(cols[4], y, 'Nothing at all', { kind: 'note', keys: [`egress:${st}`], cls: 't-stop' });
      y += 20;
    }
    for (const h of hs) {
      s.text(cols[4], y, h, { kind: 'code', keys: [`egress:${st}`] });
      y += 19;
    }
    y += 22;
  }
  s.text(cols[4], y + 4, `Drawn for ${EGRESS_EXAMPLE.ecosystems.join(' and ')} with a Claude agent. Any other host is refused and logged.`, { kind: 'figure', wrap: 220, lineHeight: 17 });

  // What the guard misses still meets the sandbox.
  const MY = guardEnd + 22;
  s.path(`M${cols[2]},${MY} H${cols[3] - 4}`, 'l-stop l-dash');
  s.arrow(cols[3] - 4, MY, 0, 'l-stop', 6);
  s.text(cols[2], MY + 24, 'What the guard misses', { kind: 'figure', cls: 't-stop' });
  s.text(cols[3] + 4, MY + 5, 'Still runs here, with no credentials', { kind: 'figure', cls: 't-stop' });

  s.text(80, H - 40, 'Drawn from the guard’s reasons, the sandbox’s secret paths, the egress proxy’s stages and the personas’ never list.', { kind: 'source' });

  return {
    name: 'sandbox',
    title: 'The path of one command',
    alt: 'The path of one command, left to right through five layers: the never list in every agent’s instructions; the claude process under its own sandbox profile, with no shell; the broker, which checks the guard and lists what it refuses; the tool profile, which writes only the run’s folders and cannot read credentials; and the run’s proxy, which allows the package registries while installing, those and the model provider while working, and nothing while the checks run.',
    width: W,
    height: H,
    labels: s.labels,
    svg: s.svg(),
  };
}
