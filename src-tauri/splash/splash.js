// Waits up to five seconds for the engine; opens the city when it answers, else shows the
// engine-down state with Start the engine. When macOS keeps the app out of the folder that holds
// the repo, shows what to turn on in System Settings instead. Runs in the Tauri window only.
const { invoke } = window.__TAURI__.core;

const LOOK_MS = 5000;
const START_MS = 30000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const body = document.body;
const startBtn = document.getElementById('start');
const retryBtn = document.getElementById('retry');
const settingsBtn = document.getElementById('settings');
const errorBox = document.getElementById('error');
const folderName = document.getElementById('folder');
const accessWhy = document.getElementById('access-why');
const settingPath = document.getElementById('setting-path');

/** Folders Files and Folders lists by name; anything else is a path. */
const NAMED = ['Downloads', 'Documents', 'Desktop'];

/** The button and note of whichever state is showing. */
function current() {
  return body.dataset.state === 'access'
    ? { btn: retryBtn, note: document.getElementById('retry-note') }
    : { btn: startBtn, note: document.getElementById('start-note') };
}

/** Draws the state's hairline across `ms`, so its length says how much of the wait is used up. */
function sweep(selector, ms) {
  for (const f of document.querySelectorAll(selector)) {
    f.style.transition = 'none';
    f.style.width = '0';
    void f.offsetWidth;
    f.style.transition = `width ${ms}ms linear`;
    f.style.width = '100%';
  }
}

/** Finishes the hairline quickly, then hands the window to the city. If that fails, says why rather than freezing. */
async function openCity() {
  for (const f of document.querySelectorAll('.fill')) {
    f.style.transition = 'width 220ms ease-out';
    f.style.width = '100%';
  }
  await sleep(240);
  try {
    await invoke('open_city');
  } catch (err) {
    body.dataset.state = 'down';
    settle();
    showError(`The engine is running, but the window could not open the city: ${err && err.message ? err.message : String(err)}`);
  }
}

/** Polls the engine's health until it answers or `ms` runs out. */
async function waitForEngine(ms) {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    if (await invoke('engine_healthy').catch(() => false)) return true;
    await sleep(250);
  }
  return false;
}

/** Empties the start hairline after a failed attempt. */
function settle() {
  const { btn, note } = current();
  btn.disabled = false;
  settingsBtn.disabled = false;
  note.textContent = '';
  for (const f of document.querySelectorAll('.down .fill')) {
    f.style.transition = 'none';
    f.style.width = '0';
  }
}

function showError(text) {
  errorBox.textContent = text;
  errorBox.hidden = false;
}

/** Says which folder macOS is holding back and where in System Settings to let Palimpsest in. */
function showAccess(folder, again) {
  const named = NAMED.includes(folder);
  folderName.textContent = folder;
  accessWhy.textContent = named
    ? `The engine runs from the Palimpsest source in your ${folder} folder, and this app is not allowed to open it yet. Turn on ${folder} for Palimpsest in System Settings, then start the engine again, or run the By hand line below in Terminal.`
    : `The engine runs from the Palimpsest source in ${folder}, and this app is not allowed to open it yet. Let Palimpsest in under Files and Folders, or add it under Full Disk Access, then start the engine again, or run the By hand line below in Terminal.`;
  settingPath.textContent = named
    ? `Privacy & Security › Files and Folders › Palimpsest › ${folder}`
    : 'Privacy & Security › Full Disk Access › Palimpsest';
  const wasShowing = body.dataset.state === 'access';
  body.dataset.state = 'access';
  if (again && wasShowing) showError('macOS is still keeping Palimpsest out. Once the switch is on, try again.');
}

async function start() {
  const { btn, note } = current();
  btn.disabled = true;
  settingsBtn.disabled = true;
  errorBox.hidden = true;
  note.textContent = 'Starting the engine';
  sweep('.down .fill', START_MS);
  try {
    await invoke('install_engine');
  } catch (err) {
    settle();
    if (err && err.kind === 'folder_access') return showAccess(err.folder, true);
    showError(err && err.message ? err.message : String(err));
    return;
  }
  note.textContent = 'Waiting for the engine to answer';
  if (await waitForEngine(START_MS)) return openCity();
  settle();
  showError('The engine was started but did not answer within 30 seconds. Its log should say why.');
}

startBtn.addEventListener('click', start);
// The by-hand line with this Mac's repo path, so it works from any folder in Terminal.
invoke('engine_command')
  .then((cmd) => {
    // Keep "engine install" together, so a wrapped line breaks after the script's path.
    const dd = document.getElementById('by-hand');
    const tail = ' engine install';
    if (!cmd.endsWith(tail)) return void (dd.textContent = cmd);
    const keep = document.createElement('span');
    keep.className = 'keep';
    keep.textContent = tail.trim();
    dd.replaceChildren(cmd.slice(0, -tail.length) + ' ', keep);
  })
  .catch(() => {});
retryBtn.addEventListener('click', start);
settingsBtn.addEventListener('click', () => {
  invoke('open_folder_access').catch((err) => showError(String(err)));
});

(async () => {
  sweep('.waking .fill', LOOK_MS);
  if (await waitForEngine(LOOK_MS)) return openCity();
  body.dataset.state = 'down';
})();
