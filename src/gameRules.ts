export const skyjoRows = 3;
export const skyjoColumns = 4;
export const skyjoWinningScore = 100;

export const skyjoCardValueCounts = [
  { value: -2, count: 5 },
  { value: -1, count: 10 },
  { value: 0, count: 15 },
  ...Array.from({ length: 12 }, (_, index) => ({ value: index + 1, count: 10 }))
] as const;

export const skyjoDeckCardCount = skyjoCardValueCounts.reduce((total, { count }) => total + count, 0);
export const skyjoDeckValueTotal = skyjoCardValueCounts.reduce(
  (total, { value, count }) => total + value * count,
  0
);
export const skyjoDefaultHiddenCardEstimate = skyjoDeckValueTotal / skyjoDeckCardCount;

export function skyjoColumnIndexes(cardIndex: number): number[] {
  const column = cardIndex % skyjoColumns;
  return [column, column + skyjoColumns, column + skyjoColumns * 2];
}
