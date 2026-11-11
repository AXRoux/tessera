# Hosting the public demo

The image in the repo root is the **offline demo**: the console and the API in one container, running on a simulated
Airwallex with a scripted agent (labelled *not Claude* everywhere it appears). It needs no keys, can move no money, and
is safe to put on a public URL so a judge can try it without cloning anything.

> **What I verified, and what I did not.** The image builds, starts as a non-root user, serves the console, refuses a
> `Host` header that is not allowed, seeds the incidents and runs the scripted agent end to end, on a local Docker
> daemon, and CI repeats the build-and-serve check on every push. It is also deployed on AWS App Runner (see
> [AWS](#aws-app-runner-the-deployment-that-is-live)): TLS, the seed and the scripted agent were checked on that URL.
> The Fly.io commands below are the standard ones, not something I ran.

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

**AWS (App Runner)**: see [the section below](#aws-app-runner-the-deployment-that-is-live), which records exactly what is deployed.

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

## AWS App Runner: the deployment that is live

Region `us-east-2`, CLI profile `tylavx`. One service, `tessera-demo`, serving the offline demo at
`https://fjd5brcvcy.us-east-2.awsapprunner.com`. Nothing in it can move money or reach a model: it holds no secrets.

| Piece | Setting | Why |
|---|---|---|
| ECR `tessera-demo` | immutable tags, scan on push, AES-256, keep the last 2 images | a tag cannot be silently replaced; storage stays pennies |
| Image | `linux/amd64`, tag `YYYY-MM-DD-<git sha>` | App Runner runs x86; build with `--provenance=false --sbom=false` so ECR gets a single manifest |
| Pull role `tessera-apprunner-ecr-pull` | read on that one repo only | the service can pull and do nothing else |
| Instance role | none | the container has no AWS access to abuse |
| Size | 0.25 vCPU, 0.5 GB, min 1 / max 1 | one shared in-memory ledger needs exactly one instance; measured ~330 MB under a 512 MB cap |
| Egress | VPC connector into a security group with **no outbound rules** | the offline demo needs no network, so a compromised process cannot call out |
| Health check | TCP on 3100 | an HTTP check sends a `Host` header the console would refuse |
| Env | `TESSERA_ALLOWED_HOSTS=<service host>` | the DNS-rebinding guard; plain HTTP is redirected to HTTPS by App Runner |
| Logs | CloudWatch, 7-day retention | |
| Budget `tessera-monthly` | $10, email at 80% actual and at 100% forecast, filtered on tag `Project=tessera` | the tag filter only counts once AWS has the tag in billing data (up to 24 h) |

Cost: about $2.6 a month for the idle memory plus a few cents of CPU while someone is using it, against a hard ceiling
near $14 a month (one instance, always busy). `pause-service` stops compute billing entirely.

```sh
export AWS_PROFILE=tylavx AWS_REGION=us-east-2
ARN=$(aws apprunner list-services --query "ServiceSummaryList[?ServiceName=='tessera-demo'].ServiceArn" --output text)

aws apprunner pause-service --service-arn $ARN      # stop paying for compute between demos
aws apprunner resume-service --service-arn $ARN

# Ship a new build (tags are immutable, so use a new one).
docker buildx build --platform linux/amd64 --provenance=false --sbom=false --load -t tessera-demo:NEW .
aws ecr get-login-password | docker login --username AWS --password-stdin 237083715820.dkr.ecr.us-east-2.amazonaws.com
docker tag tessera-demo:NEW 237083715820.dkr.ecr.us-east-2.amazonaws.com/tessera-demo:NEW
docker push 237083715820.dkr.ecr.us-east-2.amazonaws.com/tessera-demo:NEW
# then update-service with the new ImageIdentifier (keep TESSERA_ALLOWED_HOSTS in RuntimeEnvironmentVariables).
```

Tear it all down (nothing else in the account depends on these): delete the App Runner service `tessera-demo`, then its
auto scaling configuration `tessera-demo-asc` and VPC connector `tessera-demo-no-egress`, the security group
`tessera-demo-no-egress`, the ECR repository `tessera-demo`, the role `tessera-apprunner-ecr-pull` and the budget.

`.dockerignore` excludes `video/` and every nested `.env`: the root-only `.env` pattern let a local key file into the
first build of this image, caught by scanning the image before it was pushed.
