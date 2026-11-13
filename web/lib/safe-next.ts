/** Where to go after signing in: only a path on this site, never an address someone slipped into the link. */
export const safeNext = (next: string | null | undefined, fallback: string): string =>
  next && next.startsWith("/") && !next.startsWith("//") ? next : fallback;
