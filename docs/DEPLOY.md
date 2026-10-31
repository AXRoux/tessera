# Hosting the public demo

The image in the repo root is the **offline demo**: the console and the API in one container, running on a simulated
Airwallex with a scripted agent (labelled *not Claude* everywhere it appears). It needs no keys, can move no money, and
is safe to put on a public URL so a judge can try it without cloning anything.

> **What I verified, and what I did not.** The image builds, starts as a non-root user, serves the console, refuses a
> `Host` header that is not allowed, seeds the six incidents and runs the scripted agent end to end, all on a local
> Docker daemon, and CI repeats the build-and-serve check on every push. I have **not** deployed it to a cloud host:
> the commands below are the standard ones for each, not something I ran.

## Run it locally

```sh
docker build -t tessera-demo .
docker run --rm -p 3100:3100 -e TESSERA_ALLOWED_HOSTS=localhost tessera-demo
# http://localhost:3100
```

## Put it on a URL

Any host that runs a container and exposes **port 3100** works. The one setting that is easy to forget is the hostname
visitors will use: the console refuses every `Host` header that is not `localhost` or on the allowlist, which is what
stops a DNS-rebinding page from reading it.

```sh
-e TESSERA_ALLOWED_HOSTS=tessera-demo.fly.dev        # comma-separated; a name without a port matches on any port
```

**Fly.io**

```sh
fly launch --no-deploy --name tessera-demo           # accept the Dockerfile; set the internal port to 3100
fly deploy --env TESSERA_ALLOWED_HOSTS=tessera-demo.fly.dev
```

**AWS (App Runner)**: push the image to ECR, create a service from it, set the port to `3100`, the health check path to
`/`, and the environment variable `TESSERA_ALLOWED_HOSTS` to the service's hostname.

**Anywhere else**: run the image, publish 3100, set `TESSERA_ALLOWED_HOSTS`.

## One shared demo, by design

Every visitor works on the same in-memory ledger, so the image holds no state and needs no database or volume. (It is not small: about 1.1 GB, almost all of it the Next.js runtime and its compiler binaries. Pull time matters on a cold start.) It means:

- **Reset demo** on the board clears every incident for everyone and starts the walkthrough over.
- The demo also resets itself after 15 idle minutes (`TESSERA_DEMO_IDLE_RESET_MS=900000`, set in the Dockerfile), so the next
  visitor does not inherit a stranger's half-finished session. Set it to `0` to turn that off.
- If two people use it at the same moment they will see each other's incidents. For a judged demo, prefer a video plus the
  link, not a link alone.

## What a public deployment must not have

| Do not set | Why |
|---|---|
| `ANTHROPIC_API_KEY` | A public demo ignores it on purpose (it warns at startup) and runs the scripted agent, so a stranger can never spend your tokens. |
| `AWX_CLIENT_ID` / `AWX_API_KEY` | The image is offline: it never calls Airwallex. `TESSERA_PUBLIC_DEMO=1` is refused unless `TESSERA_OFFLINE=1` is also set. |
| a login | There is none by design. The only thing behind the URL is a simulator. |

The API listens on `127.0.0.1` inside the container; only the console port is published. The container runs as the
unprivileged `bun` user and has a health check on the console.

## Seeing real Claude instead

Run the demo on your own machine with a key in `.env` (`bun run demo`): the same buttons then drive Claude against the
simulated Airwallex, and `bun run dev` drives it against the real Airwallex sandbox. Never put that key on a public host.
