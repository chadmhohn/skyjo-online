export function safeAccountReturnPath(candidate: string | null): string {
  if (
    !candidate ||
    !candidate.startsWith('/') ||
    candidate.startsWith('//') ||
    candidate.includes('\\')
  ) return '/';

  for (let index = 0; index < candidate.length; index += 1) {
    const code = candidate.charCodeAt(index);
    if (code <= 31 || code === 127) return '/';
  }

  return candidate;
}
