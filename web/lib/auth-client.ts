"use client";

import { createAuthClient } from "better-auth/react";

/**
 * The browser side of Better Auth. It talks to /api/auth on this same origin, which the console forwards to the API
 * process; the session lives in an httpOnly cookie the page itself never reads.
 */
export const authClient = createAuthClient();
