declare global {
  interface String {
    isWellFormed(): boolean;
    toWellFormed(): string;
  }
}

export function isWellFormedUnicode(value: unknown): value is string;
export function toWellFormedUnicode(value: unknown): string;
export function wellFormedUTF16Prefix(value: unknown, maximumCodeUnits: number): string;
