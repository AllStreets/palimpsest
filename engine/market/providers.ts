/**
 * Which Provider serves a model (Task 6). The backends register themselves
 * (`claude:` by Task 9, `ollama:` and `anthropic:` by Task 10) with
 * registerProvider; tests and the sample engine override with setProvider,
 * and resetProviders drops the overrides.
 */
import type { ModelRef } from '../../shared/types.js';
import { anthropicProvider } from './anthropic-api.js';
import { claudeProvider } from './claude.js';
import { ollamaProvider } from './ollama.js';
import type { Provider } from './provider.js';

export type BackendKind = 'claude' | 'ollama' | 'anthropic';

const registered = new Map<BackendKind, Provider>();
const overrides = new Map<BackendKind, Provider>();

registered.set('claude', claudeProvider());
registered.set('ollama', ollamaProvider());
registered.set('anthropic', anthropicProvider());

function kindOf(model: ModelRef): BackendKind | null {
  const prefix = model.slice(0, model.indexOf(':'));
  return prefix === 'claude' || prefix === 'ollama' || prefix === 'anthropic' ? prefix : null;
}

export function providerFor(model: ModelRef): Provider {
  const kind = kindOf(model);
  const p = kind ? (overrides.get(kind) ?? registered.get(kind)) : undefined;
  if (!p) throw new Error(`no provider for ${model}`);
  return p;
}

/** A backend's own registration, kept across resetProviders. */
export function registerProvider(kind: BackendKind, p: Provider): void {
  registered.set(kind, p);
}

/** Overrides a backend, for tests and the sample engine. */
export function setProvider(kind: BackendKind, p: Provider): void {
  overrides.set(kind, p);
}

/** Drops every override, leaving the registered backends. */
export function resetProviders(): void {
  overrides.clear();
}
