# Hosting Tessera

The `Dockerfile` in the repo root builds two images from one build stage:

| Target | What it is | Keys | State |
|---|---|---|---|
| default (`docker build .`) | The **offline sandbox**: console and API in one container, on a simulated Airwallex with the scripted agent. Safe on a public URL | none | in memory |
| `--target live` | The **multi-tenant host**: people sign in (Better Auth) and bring their own Airwallex sandbox and model keys | server secrets at run time | a volume at `/data` |

Both run as the unprivileged `bun` user, publish only the console on port **3100** (the API stays on `127.0.0.1` inside
the container), and have a health check on the console. CI builds the default image and checks it serves on every push.

## The offline sandbox

```sh
docker build -t tessera .
docker run --rm -p 3100:3100 -e TESSERA_ALLOWED_HOSTS=localhost tessera
# http://localhost:3100
```

### Put it on a URL

Any host that runs a container and exposes port 3100 works. The one setting that is easy to forget is the hostname
visitors will use: the console refuses every `Host` header that is not `localhost` or on the allowlist, which is what
stops a DNS-rebinding page from reading it.

```sh
-e TESSERA_ALLOWED_HOSTS=tessera.example.com        # comma-separated; a name without a port matches on any port
```

On Fly.io, for example:

```sh
fly launch --no-deploy --name <app>                 # accept the Dockerfile; set the internal port to 3100
fly deploy --env TESSERA_ALLOWED_HOSTS=<app>.fly.dev
```

On a platform whose health checks send their own `Host` header (AWS App Runner, some load balancers), use a TCP health
check on 3100: an HTTP check would be refused by the host guard.

### One shared ledger, by design

Every visitor works on the same in-memory ledger, so the image needs no database or volume. (It is about 1.1 GB, almost
all of it the Next.js runtime; pull time matters on a cold start.) It means:

- **Reset control room** (avatar menu) clears every incident for everyone.
- It also resets itself after 15 idle minutes (`TESSERA_DEMO_IDLE_RESET_MS=900000`, set in the Dockerfile), so the next
  visitor does not inherit a stranger's half-finished session. Set it to `0` to turn that off.
- Two people using it at the same moment see each other's incidents.

### What a public offline deployment must not have

| Do not set | Why |
|---|---|
| `ANTHROPIC_API_KEY` / `TESSERA_MODEL_API_KEY` | A public sandbox ignores any model on purpose (it warns at startup) and runs the scripted agent, so a stranger can never spend your tokens. |
| `AWX_CLIENT_ID` / `AWX_API_KEY` | The image is offline: it never calls Airwallex. `TESSERA_PUBLIC_DEMO=1` is refused unless `TESSERA_OFFLINE=1` is also set. |

Nothing in it can move money or reach a model, so it can run with no outbound network at all.

To try a real model against the simulator, run it on your own machine with a key in `.env` (`bun run demo`); `bun run dev`
drives it against the real Airwallex sandbox. Never put that key on a public host.

## The multi-tenant host (`--target live`)

People create an account (email and password, optionally Google or Apple) and get a private workspace. It opens on the
offline sandbox; on *Workspace and keys* they can connect their own **Airwallex sandbox** keys (the workspace goes live,
with a ledger file of its own) and their own **model** key (Anthropic or any OpenAI-compatible endpoint). Every approval
is signed with the signed-in person's email.

```sh
docker build --target live -t tessera-live .
docker run -d -p 3100:3100 -v tessera-data:/data \
  -e TESSERA_API_TOKEN=... -e TESSERA_MASTER_KEY=... -e BETTER_AUTH_SECRET=... \
  -e BETTER_AUTH_URL=https://tessera.example.com -e TESSERA_ALLOWED_HOSTS=tessera.example.com \
  tessera-live
```

| Variable | |
|---|---|
| `TESSERA_API_TOKEN` | the console's token for the API inside the container (`openssl rand -hex 32`) |
| `TESSERA_MASTER_KEY` | seals the keys people bring (`openssl rand -hex 32`). Losing it makes every stored key unreadable (people reconnect); never rotate it without re-sealing |
| `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` | session signing, and the public URL people sign in on |
| `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`, `APPLE_CLIENT_ID`/`APPLE_CLIENT_SECRET` | optional; each pair turns on that sign-in |

Put TLS in front of it (Caddy, a load balancer) and make sure the proxy **overwrites** `X-Forwarded-For` rather than
appending to it: the console takes the client address from that header for rate limits.

**Keys people bring** are checked with the provider before saving, sealed with AES-256-GCM under a key derived per
workspace (HKDF from `TESSERA_MASTER_KEY`, authenticated data binding user and field), and only ever shown as their last
four characters. The host accepts the Airwallex **sandbox** only.

**What persists** in `/data`: accounts, sealed keys, and the ledgers of live workspaces. Back the volume up. An offline
workspace keeps its simulated Airwallex in memory, so its board starts fresh after a restart or 30 idle minutes.

### A single host on AWS

`deploy/live/` holds a working recipe for one EC2 instance (Amazon Linux 2023) running the live image behind Caddy:

- `user-data.sh`: first boot. Installs Docker and writes `/opt/tessera/config` (`IMAGE=`, `HOST=`) and `up.sh`; the
  launch command substitutes `__IMAGE__`, `__HOST__` and `__UP_SH__` (base64 of `up.sh`).
- `up.sh`: starts or restarts the app. Pulls the image from ECR, reads the secrets above from Secrets Manager
  (`tessera/live`, a JSON object) through the instance role, writes them root-only for `docker run` and deletes them,
  then starts the app and Caddy (Let's Encrypt, HSTS, `X-Forwarded-For` overwritten). Re-run it to ship a new image.

Give the instance role read on that one secret and that one repository (plus SSM core for a shell without SSH), open
80 and 443 only, use an Elastic IP (Airwallex webhooks want a fixed address), and snapshot the root volume.

`.dockerignore` excludes every nested `.env`, so a local key file never ends up in an image.
