"use client";

import { authClient } from "./auth-client";

/** The person signed in on this browser (multi-tenant mode). */
export interface SignedIn {
  name: string;
  email: string;
}

/**
 * Who is signed in, kept current. The server's answer paints the page (no flash of "Sign in" for someone who is);
 * from then on Better Auth's session store has the last word, and it follows sign-in and sign-out everywhere on the
 * page without a reload. Pages restored by Back come back with whatever the store knows now, not what they were
 * rendered with. Only for the multi-tenant host: one operator has no sessions to ask about.
 */
export function useSignedIn(initial: SignedIn | null): SignedIn | null {
  const session = authClient.useSession();
  // Not asked yet, or the answer did not arrive: trust what the server saw.
  if ((session.isPending && !session.data) || session.error) return initial;
  const user = session.data?.user;
  return user ? { name: user.name, email: user.email } : null;
}

