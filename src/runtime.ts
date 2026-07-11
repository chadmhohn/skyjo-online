export type RandomSource = () => number;

export interface Clock {
  now(): number;
}

export const systemRandom: RandomSource = () => Math.random();

export const systemClock: Clock = {
  now: () => Date.now()
};

export function createSeededRandom(seed: number): RandomSource {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let mixed = value;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}
