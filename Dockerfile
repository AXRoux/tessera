# The public offline demo: API and console in one container. Airwallex is the in-process simulator and the agent is the
# scripted one (not Claude), so the image needs no keys and can move no money. The API stays on 127.0.0.1 inside the
# container; only the console (port 3100) is published.
#
#   docker build -t tessera-demo .
#   docker run --rm -p 3100:3100 -e TESSERA_ALLOWED_HOSTS=localhost tessera-demo
#
# For a public URL, list the hostname visitors use: -e TESSERA_ALLOWED_HOSTS=localhost,demo.example.com (docs/DEPLOY.md).
# Every visitor shares one in-memory demo. "Reset demo" in the console clears it, and it clears itself after 15 idle minutes.
FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY web/package.json web/bun.lock web/
RUN cd web && bun install --frozen-lockfile
COPY . .
RUN cd web && bun run build
# The build needs the dev dependencies (Tailwind, TypeScript); running does not. Drop them before the final copy.
RUN rm -rf node_modules web/node_modules && bun install --production --frozen-lockfile && cd web && bun install --production --frozen-lockfile

# The multi-tenant host (docker build --target live): people sign in with Better Auth and bring their own Airwallex sandbox
# and model keys. It needs TESSERA_API_TOKEN, TESSERA_MASTER_KEY, BETTER_AUTH_SECRET, BETTER_AUTH_URL and
# TESSERA_ALLOWED_HOSTS at run time (never baked in), and a volume at /data for accounts, sealed keys and ledgers.
# See docs/DEPLOY.md. Built before the demo stage so that a plain `docker build` still produces the public demo.
FROM oven/bun:1 AS live
WORKDIR /app
COPY --from=build --chown=bun:bun /app /app
RUN mkdir -p /data && chown bun:bun /data
ENV NODE_ENV=production \
    TESSERA_AUTH=1 \
    TESSERA_DATA_DIR=/data
USER bun
VOLUME /data
EXPOSE 3100
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:3100/').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
# umask 077: accounts, sealed keys and ledgers are readable by this user alone.
CMD ["sh", "-c", "umask 077 && exec bun run scripts/dev.ts --production --host 0.0.0.0"]

FROM oven/bun:1 AS demo
WORKDIR /app
COPY --from=build --chown=bun:bun /app /app
ENV NODE_ENV=production \
    TESSERA_OFFLINE=1 \
    TESSERA_PUBLIC_DEMO=1 \
    TESSERA_DEMO_IDLE_RESET_MS=900000
USER bun
EXPOSE 3100
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:3100/').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["bun", "run", "scripts/dev.ts", "--offline", "--production", "--host", "0.0.0.0"]
