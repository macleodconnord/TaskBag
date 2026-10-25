import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing';

/** Fractional-index positions for drag-and-drop ordering (string compare = order). */
export const positionBetween = (before: string | null, after: string | null) => generateKeyBetween(before, after);
export const positionsBetween = (before: string | null, after: string | null, n: number) =>
  generateNKeysBetween(before, after, n);
