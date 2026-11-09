export type Era = 'stone' | 'brick' | 'glass' | 'titanium' | 'scifi';
export type RootStyle = 'beauxarts' | 'roman' | 'gothic' | 'pagoda' | 'chicago';
export type FloorSize = 'small' | 'medium' | 'large';

export interface Repo {
  fullName: string;
  private: boolean;
  defaultBranch: string;
  language: string | null;
  description: string | null;
  connected: boolean;
  pushMode: boolean;
  root: RootStyle;
  slot: number;
  status: 'idle' | 'analyzing' | 'ready' | 'error';
  error: string | null;
  connectedAt: string | null;
  analyzedAt: string | null;
}

export interface Floor {
  id: string;
  repo: string;
  kind: 'pr' | 'commits';
  refs: string[];
  title: string;
  at: string;
  era: Era;
  size: FloorSize;
  lines: number;
  claude: boolean;
  founding: true;
  url: string | null;
}

export interface TowerSpec {
  id: string;
  repo: string;
  kind: 'founding';
  root: RootStyle;
  floors: Floor[];
  datumIndex: number;
}

export interface District {
  repo: string;
  index: number;
  origin: { x: number; z: number };
  tower: TowerSpec;
}

export interface UsageWindow {
  usedPercentage: number;
  resetsAt: number;
}

export interface UsageReading {
  at: number;
  fiveHour: UsageWindow | null;
  sevenDay: UsageWindow | null;
}

export interface Settings {
  quality: 'high' | 'medium';
  dayCapPct: number;
  nightCapPct: number;
  hookInstalled: boolean;
  previousStatusLine: unknown | null;
}
