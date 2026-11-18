/**
 * Links that leave the city (GitHub, a screenshot the engine serves) open in
 * the default browser. Inside the Mac app the page is the engine's own
 * http://127.0.0.1 origin, where WKWebView will not open a second window for
 * a target=_blank link, so the click asks the shell to open it
 * (open_external in src-tauri/src/main.rs). In a plain browser it opens a
 * tab. Only http and https ever leave; anything else is refused here and
 * again in the shell.
 */

export type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

export interface ExternalEnv {
  /** Tauri's invoke, or null in a plain browser. */
  invoke: Invoke | null;
  /** The browser's window.open. */
  open: (url: string, target: string, features: string) => unknown;
  /** The page's own address, for a link given relative to it. */
  base: string;
}

/** Tauri's invoke when this page runs inside the app, else null. */
export function tauriInvoke(scope: unknown = globalThis): Invoke | null {
  const w = scope as { __TAURI_INTERNALS__?: { invoke?: unknown }; __TAURI__?: { core?: { invoke?: unknown } } };
  const fn = w.__TAURI_INTERNALS__?.invoke ?? w.__TAURI__?.core?.invoke;
  return typeof fn === 'function' ? (fn as Invoke) : null;
}

function defaultEnv(): ExternalEnv {
  return {
    invoke: tauriInvoke(),
    open: (url, target, features) => window.open(url, target, features),
    base: typeof location === 'undefined' ? 'http://127.0.0.1/' : location.href,
  };
}

/** The absolute http(s) address of `url`, or null for any other scheme or a malformed one. */
export function externalHref(url: string, base: string): string | null {
  let u: URL;
  try {
    u = new URL(url, base);
  } catch {
    return null;
  }
  return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname ? u.href : null;
}

/**
 * Opens `url` in the default browser: through the shell in the app, a new tab
 * otherwise. Resolves to how it went: 'app', 'browser', or 'refused' for a
 * scheme that may not leave. A shell that fails falls back to window.open.
 */
export async function openExternal(url: string, env: ExternalEnv = defaultEnv()): Promise<'app' | 'browser' | 'refused'> {
  const href = externalHref(url, env.base);
  if (!href) return 'refused';
  if (env.invoke) {
    try {
      await env.invoke('open_external', { url: href });
      return 'app';
    } catch {
      // The shell said no (an older build, say): the webview may still manage a tab.
    }
  }
  env.open(href, '_blank', 'noopener,noreferrer');
  return 'browser';
}

/**
 * Makes `a` a link that leaves the city: it keeps a real href (for hover,
 * copy and the status bar), and a click opens it through openExternal before
 * anything else runs, so a re-render `then` starts cannot take the click
 * away. `then` runs after the open has been asked for.
 */
export function externalLink<A extends HTMLAnchorElement>(a: A, href: string, then?: () => void): A {
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.addEventListener('click', (ev) => {
    ev.preventDefault();
    void openExternal(href);
    then?.();
  });
  return a;
}
