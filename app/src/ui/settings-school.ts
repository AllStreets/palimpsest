/**
 * Settings' School section (Phase 4 Task 32): the school's switch, its
 * hours, the idle wait, Low Power, the gate as it reads now with "Train
 * now", what it may spend on Claude each day, the designer's model, his
 * commits and his taste, the base model's download and the trainer.
 *
 * Every field is sent as typed through `PATCH /api/settings { school }` and
 * checked there (engine/school/api.ts): a refusal stands under the field in
 * the engine's own sentence, and nothing refused is kept. The base model
 * comes down only through `POST /api/school/download-base`, on his click.
 */
import type { SchoolSettings } from '../../../shared/types';
import { api, ApiError, type SchoolView } from '../api';
import { cleanText } from './board';
import { button, createSwitch, el, markBusy, textButton } from './controls';
import { refusal } from './pages';
import { baseButton, dailyCreditsText, downloadLine, gateLine, lowPowerNote, trainerLine, trainNowHeld, untilLine } from './school-words';

type Row = { row: HTMLElement; main: HTMLElement; side: HTMLElement };
type SchoolPatch = Partial<Pick<SchoolSettings, 'enabled' | 'window' | 'idleMinutes' | 'allowLowPower' | 'claudeCreditsPerDay' | 'designer' | 'understudy' | 'commitsAsWork'>>;

export interface SchoolSettingsBlock {
  /** Fills every row from the school's view, or says the engine did not answer. */
  fill(v: SchoolView | null): void;
  /** True while the base model is coming down, so the page reads the school again soon. */
  readonly downloading: boolean;
}

/** The engine's sentence from a refused call, as it wrote it. */
const said = (err: unknown): string => (err instanceof ApiError || err instanceof Error ? err.message : String(err));

/** "1:00" as "01:00", so a time typed without its leading zero reaches the engine as it reads times. */
const padTime = (s: string): string => (/^\d:\d\d$/.test(s.trim()) ? `0${s.trim()}` : s.trim());

export function schoolSettings(sec: HTMLElement, aside: HTMLElement, row: (label: string, sub?: string) => Row, changed: () => void): SchoolSettingsBlock {
  let view: SchoolView | null = null;
  let saved: SchoolSettings | null = null;

  /** Sends one part of the school's settings; the engine's answer is kept, or its refusal shown under `why`. */
  async function send(part: SchoolPatch, why: HTMLElement, field?: HTMLElement): Promise<boolean> {
    try {
      const s = await api.patchSettings({ school: part });
      saved = s.school;
      why.hidden = true;
      why.textContent = '';
      field?.removeAttribute('aria-invalid');
      return true;
    } catch (err) {
      why.textContent = said(err);
      why.hidden = false;
      field?.setAttribute('aria-invalid', 'true');
      return false;
    } finally {
      changed();
    }
  }

  const whyLine = (cls: string): HTMLElement => {
    const p = el('p', `set-error ${cls}`);
    p.id = cls;
    p.setAttribute('role', 'alert');
    p.hidden = true;
    return p;
  };

  /** A switch row: the label on the left, what it does beneath, the switch on the right. */
  function switchRow(key: 'enabled' | 'allowLowPower' | 'commitsAsWork' | 'understudy', label: string, text: string | null, cls: string): { sw: ReturnType<typeof createSwitch>; main: HTMLElement; note: HTMLElement } {
    const r = row(label);
    r.row.classList.add('set-school', cls);
    const why = whyLine(`${cls}-why`);
    const sw = createSwitch(cls, label, (on) => {
      sw.set(on);
      markBusy(sw.el, true);
      void send({ [key]: on }, why).then((ok) => {
        markBusy(sw.el, false);
        if (!ok && saved) sw.set(saved[key]);
      });
    });
    const note = el('p', 'set-note');
    if (text) {
      const t = el('p', 'set-text', text);
      t.addEventListener('click', () => sw.el.click());
      r.main.append(t);
    }
    r.main.append(note, why);
    r.side.append(sw.el);
    sw.el.hidden = true;
    return { sw, main: r.main, note };
  }

  /** A typed field under a rule, as Caps and Analysis set theirs: sent on Enter or on leaving it, Escape puts it back. */
  function field(cls: string, aria: string, o: { width: string; maxLength: number; numeric?: boolean; left?: boolean }): { wrap: HTMLElement; input: HTMLInputElement } {
    const wrap = el('label', `cap-field school-field ${cls}-field`);
    const input = el('input', `cap school-cap ${cls}`);
    input.type = 'text';
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.maxLength = o.maxLength;
    if (o.numeric) input.inputMode = 'numeric';
    input.style.width = o.width;
    if (o.left) input.style.textAlign = 'left';
    input.setAttribute('aria-label', aria);
    wrap.append(input);
    return { wrap, input };
  }

  /** Wires a field: `value()` is what it would send; `back()` puts the saved value back. */
  function wire(inputs: HTMLInputElement[], why: HTMLElement, o: { part(): SchoolPatch | null; same(): boolean; back(): void }): void {
    let refusedAs: string | null = null;
    const key = () => inputs.map((i) => i.value.trim()).join(' ');
    const commit = (): void => {
      if (o.same()) {
        why.hidden = true;
        for (const i of inputs) i.removeAttribute('aria-invalid');
        return;
      }
      // The same refused value is not sent again until he changes it.
      if (refusedAs === key()) return;
      const part = o.part();
      if (!part) return;
      const sent = key();
      void send(part, why, inputs[0]).then((ok) => {
        refusedAs = ok ? null : sent;
        for (const i of inputs) {
          if (ok) i.removeAttribute('aria-invalid');
          else i.setAttribute('aria-invalid', 'true');
        }
        if (ok) o.back();
      });
    };
    for (const input of inputs) {
      input.setAttribute('aria-describedby', why.id);
      input.addEventListener('input', () => {
        refusedAs = null;
        input.removeAttribute('aria-invalid');
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          o.back();
          why.hidden = true;
          refusedAs = null;
          for (const i of inputs) i.removeAttribute('aria-invalid');
          input.blur();
        }
      });
      input.addEventListener('blur', () => {
        // Moving from one end of the window to the other is not leaving the field.
        requestAnimationFrame(() => {
          if (!inputs.includes(document.activeElement as HTMLInputElement)) commit();
        });
      });
    }
  }

  // ---------------------------------------------------------------- the switch

  const run = switchRow('enabled', 'Run the school', 'Off by default. While on, the city trains its nets at night, races agents on arenas you build, and trains coders on this Mac.', 'school-on');

  // ---------------------------------------------------------------- the window and the idle wait

  const winRow = row('Train between');
  winRow.row.classList.add('set-school', 'school-window-row');
  const from = field('school-from', 'Training window from, as HH:MM', { width: '4.4ch', maxLength: 5 });
  const to = field('school-to', 'Training window to, as HH:MM', { width: '4.4ch', maxLength: 5 });
  const winWhy = whyLine('school-window-why');
  const winLine = el('div', 'school-window');
  winLine.append(from.wrap, el('span', 'school-to-word', 'to'), to.wrap, el('span', 'cap-of', 'local time, nightly; it may cross midnight'));
  winRow.main.append(winLine, winWhy);
  wire([from.input, to.input], winWhy, {
    part: () => ({ window: { from: padTime(from.input.value), to: padTime(to.input.value) } }),
    same: () => !!saved && padTime(from.input.value) === saved.window.from && padTime(to.input.value) === saved.window.to,
    back: () => {
      if (!saved) return;
      from.input.value = saved.window.from;
      to.input.value = saved.window.to;
    },
  });

  const idleRow = row('Only after the Mac has been idle for');
  idleRow.row.classList.add('set-school', 'school-idle-row');
  const idle = field('school-idle', 'Idle minutes before heavy training, 5 to 120', { width: '3.6ch', maxLength: 3, numeric: true });
  const idleWhy = whyLine('school-idle-why');
  const idleLine = el('div', 'school-window');
  idleLine.append(idle.wrap, el('span', 'cap-of', 'minutes, 5 to 120, before a LoRA, an arena or a voyage starts'));
  idleRow.main.append(idleLine, idleWhy);
  wire([idle.input], idleWhy, {
    part: () => {
      const raw = idle.input.value.trim();
      // Sent as he typed it: a whole number goes as a number, anything else as he wrote it, for the engine to answer.
      return { idleMinutes: (/^\d+$/.test(raw) ? Number(raw) : raw) as number };
    },
    same: () => !!saved && idle.input.value.trim() === String(saved.idleMinutes),
    back: () => {
      if (saved) idle.input.value = String(saved.idleMinutes);
    },
  });

  // ---------------------------------------------------------------- Low Power

  const low = switchRow('allowLowPower', 'Train in Low Power mode on power', null, 'school-lowpower');

  // ---------------------------------------------------------------- the gate and Train now

  const nowRow = row('Train now');
  nowRow.row.classList.add('set-school', 'school-now-row');
  const gateP = el('p', 'set-text school-gate');
  gateP.setAttribute('aria-live', 'polite');
  const heldP = el('p', 'set-note school-held');
  heldP.id = 'school-held';
  const nowNote = el('p', 'set-note', 'For three hours it trains outside the window and without the idle wait; never on battery, warm or short of disk.');
  const nowWhy = whyLine('school-now-why');
  nowRow.main.append(gateP, heldP, nowNote, nowWhy);
  const trainNow = button('school-train-now', 'Train now', () => void pressTrainNow());
  const until = el('span', 'school-until');
  const stopNow = textButton('school-stop', 'Stop', () => void pressStop());
  const nowSide = el('div', 'school-now-side');
  nowSide.append(trainNow, until, stopNow);
  nowRow.side.append(nowSide);
  trainNow.hidden = true;
  until.hidden = true;
  stopNow.hidden = true;
  let pressing = false;

  async function pressTrainNow(): Promise<void> {
    if (pressing || trainNow.getAttribute('aria-disabled') === 'true') return;
    pressing = true;
    markBusy(trainNow, true);
    nowWhy.hidden = true;
    try {
      await api.trainNow();
    } catch (err) {
      nowWhy.textContent = refusal('Train now', err);
      nowWhy.hidden = false;
    } finally {
      pressing = false;
      markBusy(trainNow, false);
      changed();
    }
  }

  async function pressStop(): Promise<void> {
    if (pressing) return;
    pressing = true;
    nowWhy.hidden = true;
    try {
      await api.stopTrainNow();
    } catch (err) {
      nowWhy.textContent = refusal('Stop', err);
      nowWhy.hidden = false;
    } finally {
      pressing = false;
      changed();
    }
  }

  // ---------------------------------------------------------------- Claude, the designer

  const creditsRow = row('The school may spend on Claude each day');
  creditsRow.row.classList.add('set-school', 'school-credits-row');
  const credits = field('school-credits', 'Credits the school may spend on Claude each day, 0 to 100', { width: '3.6ch', maxLength: 3, numeric: true });
  const creditsOf = el('span', 'cap-of school-credits-of');
  const creditsWhy = whyLine('school-credits-why');
  const creditsLine = el('div', 'school-window');
  creditsLine.append(credits.wrap, creditsOf);
  creditsRow.main.append(creditsLine, el('p', 'set-note', "It takes one of the city's Claude slots and waits while you are using Claude."), creditsWhy);
  wire([credits.input], creditsWhy, {
    part: () => {
      const raw = credits.input.value.trim();
      return { claudeCreditsPerDay: (/^\d+$/.test(raw) ? Number(raw) : raw) as number };
    },
    same: () => !!saved && credits.input.value.trim() === String(saved.claudeCreditsPerDay),
    back: () => {
      if (!saved) return;
      credits.input.value = String(saved.claudeCreditsPerDay);
      creditsOf.textContent = dailyCreditsText(saved.claudeCreditsPerDay);
    },
  });

  const designRow = row('Design agents with');
  designRow.row.classList.add('set-school', 'school-designer-row');
  const designer = field('school-designer', 'Model that designs agents: ollama:name or claude:name', { width: '30ch', maxLength: 130, left: true });
  const designWhy = whyLine('school-designer-why');
  designRow.main.append(designer.wrap, el('p', 'set-note', "The model that writes a voyage's children from their parents; on Claude it spends the allowance above."), designWhy);
  wire([designer.input], designWhy, {
    part: () => ({ designer: designer.input.value.trim() as SchoolSettings['designer'] }),
    same: () => !!saved && designer.input.value.trim() === saved.designer,
    back: () => {
      if (saved) designer.input.value = saved.designer;
    },
  });

  // ---------------------------------------------------------------- his commits, his taste

  const commits = switchRow('commitsAsWork', 'Count my own commits as verified work', 'Commits that touched source, lasted 30 days with no revert or fix, and pass their tests. This goes beyond changes the guild inspected.', 'school-commits');
  const taste = switchRow('understudy', 'Read your taste from Understudy', 'Read only, on this Mac. Your taste statements are also added to the bar every UI change in the market is judged against.', 'school-understudy');

  // ---------------------------------------------------------------- the base model and the trainer

  const baseRow = row('Base model for coders');
  baseRow.row.classList.add('set-school', 'school-base-row');
  const baseState = el('p', 'set-text school-base-state');
  baseState.setAttribute('aria-live', 'polite');
  const baseWhy = whyLine('school-base-why');
  baseRow.main.append(baseState, el('p', 'set-note', 'Your Hugging Face login is not sent.'), baseWhy);
  const download = button('school-download', 'Download, about 4.3 GB', () => void pressDownload());
  const ready = el('span', 'school-ready', 'Ready');
  baseRow.side.append(download, ready);
  download.hidden = true;
  ready.hidden = true;
  let asking = false;

  async function pressDownload(): Promise<void> {
    if (asking || download.getAttribute('aria-disabled') === 'true') return;
    asking = true;
    baseWhy.hidden = true;
    markBusy(download, true);
    try {
      await api.downloadBase();
    } catch (err) {
      baseWhy.textContent = refusal('The download', err);
      baseWhy.hidden = false;
    } finally {
      asking = false;
      markBusy(download, false);
      changed();
    }
  }

  const trainerRow = row('Trainer');
  trainerRow.row.classList.add('set-school', 'school-trainer-row');
  const trainerP = el('p', 'set-text school-trainer');
  trainerRow.main.append(trainerP, el('p', 'set-note', 'MLX in its own environment, beside the app; it runs offline in a sandbox.'));

  sec.append(el('p', 'set-foot', "The school trains only when the gate holds: on power, idle, inside the window, cool, with disk, and no local job waiting. Its Claude spend counts in the caps above, and the treasury shows it with its training."));

  // ---------------------------------------------------------------- fill

  const typing = (i: HTMLInputElement): boolean => document.activeElement === i || i.getAttribute('aria-invalid') === 'true';

  function fill(v: SchoolView | null): void {
    view = v;
    if (!v) {
      aside.textContent = '';
      gateP.textContent = 'The engine did not answer.';
      for (const s of [run, low, commits, taste]) s.sw.el.hidden = true;
      for (const f of [from, to, idle, credits, designer]) f.wrap.hidden = true;
      trainNow.hidden = true;
      until.hidden = true;
      stopNow.hidden = true;
      download.hidden = true;
      ready.hidden = true;
      baseState.textContent = '';
      trainerP.textContent = '';
      return;
    }
    const s = v.settings;
    saved = s;
    aside.textContent = s.enabled ? 'on' : 'off';
    for (const [w, k] of [[run, 'enabled'], [low, 'allowLowPower'], [commits, 'commitsAsWork'], [taste, 'understudy']] as const) {
      if (w.sw.el.getAttribute('aria-busy') !== 'true') w.sw.set(s[k]);
      w.sw.el.hidden = false;
    }
    if (!typing(from.input) && !typing(to.input)) {
      from.input.value = s.window.from;
      to.input.value = s.window.to;
    }
    if (!typing(idle.input)) idle.input.value = String(s.idleMinutes);
    if (!typing(credits.input)) {
      credits.input.value = String(s.claudeCreditsPerDay);
      creditsOf.textContent = dailyCreditsText(s.claudeCreditsPerDay);
    }
    if (!typing(designer.input)) designer.input.value = s.designer;
    for (const f of [from, to, idle, credits, designer]) f.wrap.hidden = false;

    const g = v.gate.heavy;
    const lp = lowPowerNote(g);
    low.note.textContent = lp ?? 'Off by default: training waits while the Mac is in Low Power mode.';
    low.note.classList.toggle('school-lowpower-now', lp !== null);

    gateP.textContent = gateLine(g, s.window);
    const live = g.trainNowUntil;
    const held = trainNowHeld(g);
    if (live) {
      trainNow.hidden = true;
      until.hidden = false;
      until.textContent = untilLine(live);
      stopNow.hidden = false;
      heldP.hidden = true;
    } else {
      trainNow.hidden = false;
      until.hidden = true;
      stopNow.hidden = true;
      if (held) {
        trainNow.setAttribute('aria-disabled', 'true');
        trainNow.setAttribute('aria-describedby', heldP.id);
        heldP.textContent = `Train now waits: ${held}.`;
        heldP.hidden = false;
      } else {
        trainNow.removeAttribute('aria-disabled');
        trainNow.removeAttribute('aria-describedby');
        heldP.hidden = true;
      }
    }

    const b = baseButton(v.lora);
    // The model's name never breaks at its hyphens.
    baseState.textContent = downloadLine(v.lora, cleanText(s.baseModel, 80).replace(/-/g, '\u2011'));
    download.hidden = b.state === 'ready';
    ready.hidden = b.state !== 'ready';
    download.textContent = b.label;
    if (b.state === 'running') download.setAttribute('aria-disabled', 'true');
    else download.removeAttribute('aria-disabled');
    download.dataset.state = b.state;
    trainerP.textContent = trainerLine(v.trainer);
  }

  return {
    fill,
    get downloading() {
      return !!view?.lora.download?.running;
    },
  };
}
