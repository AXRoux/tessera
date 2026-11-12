/**
 * How strong a new password looks, for the meter on sign-up. A guide, not a gate: the server's rule is the length
 * (10 to 128 characters). Rewards length first, then variety, and marks down the patterns people reach for first.
 */
export interface Strength {
  /** 0 (too short) to 4 (excellent). */
  score: 0 | 1 | 2 | 3 | 4;
  label: "Too short" | "Weak" | "Fair" | "Strong" | "Excellent";
}

const COMMON = /(password|passw0rd|qwerty|letmein|welcome|admin|tessera|airwallex|123456|abcdef|iloveyou)/i;

export function passwordStrength(password: string, minLength = 10): Strength {
  if (password.length < minLength) return { score: 0, label: "Too short" };
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  let points = 1;
  if (password.length >= 14) points++;
  if (password.length >= 20) points++;
  if (classes >= 3) points++;
  if (/\s/.test(password) && password.trim().split(/\s+/).length >= 3) points++;
  if (COMMON.test(password)) points -= 2;
  if (/(.)\1{3,}/.test(password)) points--;
  const score = Math.max(1, Math.min(4, points)) as Strength["score"];
  return { score, label: (["Too short", "Weak", "Fair", "Strong", "Excellent"] as const)[score] };
}
