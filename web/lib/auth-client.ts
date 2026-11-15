"use client";

import { createAuthClient } from "better-auth/react";
import { inferAdditionalFields } from "better-auth/client/plugins";
import type { Auth } from "../../src/server/auth";

/**
 * The browser side of Better Auth. It talks to /api/auth on this same origin, which the console forwards to the API
 * process; the session lives in an httpOnly cookie the page itself never reads. inferAdditionalFields teaches it the
 * one extra field sign-up writes: when the terms were accepted.
 */
export const authClient = createAuthClient({ plugins: [inferAdditionalFields<Auth>()] });
