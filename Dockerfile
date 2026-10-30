# The public offline demo: API and console in one container. Airwallex is the in-process simulator and the agent is the
# scripted one (not Claude), so the image needs no keys and can move no money. The API stays on 127.0.0.1 inside the
# container; only the console (port 3100) is published.
#
#   docker build -t tessera-demo .
#   docker run --rm -p 3100:3100 -e TESSERA_ALLOWED_HOSTS=localhost,demo.example.com tessera-demo
FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY web/package.json web/bun.lock web/
RUN cd web && bun install --frozen-lockfile
COPY . .
RUN cd web && bun run build

FROM oven/bun:1
WORKDIR /app
COPY --from=build /app /app
ENV NODE_ENV=production \
    TESSERA_OFFLINE=1 \
    TESSERA_PUBLIC_DEMO=1
EXPOSE 3100
CMD ["bun", "run", "scripts/dev.ts", "--offline", "--production", "--host", "0.0.0.0"]
