import type { SoloAiDifficultySelection, SoloSessionRecord } from './soloDurability';

export type SoloIntent = 'continue' | 'new';
export type SoloSetupOrigin = 'home' | 'launcher' | 'active' | 'game-over';

export const soloDifficultyOptions: ReadonlyArray<{
  value: SoloAiDifficultySelection;
  label: string;
  description: string;
  recommended?: boolean;
}> = [
  { value: 'easy', label: 'Easy', description: 'Varied, forgiving choices.' },
  {
    value: 'medium',
    label: 'Medium',
    description: 'Balanced play with straightforward visible-card estimates.',
    recommended: true
  },
  { value: 'hard', label: 'Hard', description: 'Sharper choices using cards everyone can see.' },
  {
    value: 'ultra',
    label: 'Ultra Hard',
    description: 'Strongest search, including likely draw outcomes and end-round risk.'
  },
  {
    value: 'mixed',
    label: 'Mixed',
    description: 'Each bot gets a fixed level, spread as evenly as the roster allows.'
  }
];

export function soloDifficultyLabel(difficulty: SoloAiDifficultySelection): string {
  if (difficulty === 'easy') return 'Easy';
  if (difficulty === 'medium') return 'Medium';
  if (difficulty === 'ultra') return 'Ultra Hard';
  if (difficulty === 'mixed') return 'Mixed';
  return 'Hard';
}

export function formatSoloSavedAt(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(timestamp));
}

export function soloSessionSummary(session: SoloSessionRecord): string {
  const opponents = `${session.aiOpponentCount} AI opponent${session.aiOpponentCount === 1 ? '' : 's'}`;
  return `Round ${session.state.round} · ${opponents} · ${soloDifficultyLabel(session.setup.difficulty)}`;
}
