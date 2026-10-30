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

FROM oven/bun:1
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
