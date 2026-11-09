import * as THREE from 'three';

import type { District } from '../../shared/types';
import { api } from './api';
import { createCity, type PickHit } from './city/scene';
import { onRoute } from './router';

interface DebugHandle {
  ready: boolean;
  districts: number;
  lastPick: PickHit | null;
  view(eye: number[], target: number[]): void;
}

declare global {
  interface Window {
    __palimpsest?: DebugHandle;
  }
}

const REFRESH_ON = new Set(['repo.analyzed', 'repo.error']);

async function main(): Promise<void> {
  const host = document.getElementById('city');
  const veil = document.getElementById('veil');
  if (!host) throw new Error('missing #city');

  const quality = await api.settings().then(
    (s) => s.quality,
    () => 'high' as const,
  );
  const city = createCity(host, { quality });

  const debug: DebugHandle = {
    ready: false,
    districts: 0,
    lastPick: null,
    view: (e, t) => city.view(new THREE.Vector3(e[0], e[1], e[2]), new THREE.Vector3(t[0], t[1], t[2])),
  };
  window.__palimpsest = debug;
  // Task 9 opens the inspector here; for now a pick is only recorded.
  city.onPick((hit) => {
    debug.lastPick = hit;
  });

  const show = (districts: District[]): void => {
    city.setDistricts(districts);
    debug.districts = districts.length;
  };

  let districts: District[] = [];
  try {
    districts = await api.city();
  } catch (err) {
    console.warn('could not load the city from the engine', err);
  }
  show(districts);

  let refreshing: Promise<void> | null = null;
  api.events((e) => {
    if (!REFRESH_ON.has(e.type) || refreshing) return;
    refreshing = api
      .city()
      .then(show, (err) => console.warn('city refresh failed', err))
      .finally(() => {
        refreshing = null;
      });
  });

  // Repos and Settings (Task 10) draw over the city, which keeps running underneath.
  onRoute((route) => {
    document.body.dataset.route = route;
  });

  await city.ready;
  debug.ready = true;
  veil?.classList.add('gone');
  setTimeout(() => veil?.remove(), 1400);
}

void main();
