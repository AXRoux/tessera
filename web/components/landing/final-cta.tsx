import type { Health } from "../../../src/server/wire";
import { StartButton } from "../tour";
import { LinkButton } from "../ui";
import { Container } from "./section";

/** The last word: one high-contrast card with a single, obvious thing to do. */
export function FinalCta({ health }: { health: Health | null }) {
  return (
    <section className="pt-28 sm:pt-36" aria-labelledby="cta-title">
      <Container>
        <div className="flex flex-col items-center rounded-[32px] bg-white px-6 py-16 text-center text-black sm:px-12 sm:py-24">
          <h2 id="cta-title" className="max-w-3xl text-balance text-[clamp(32px,4.8vw,56px)] font-light leading-[1.05] tracking-[-0.04em]">
            Want to watch an agent be told no?
          </h2>
          <p className="mt-6 max-w-xl text-pretty text-[clamp(16px,1.5vw,18px)] font-light leading-[1.6] text-black/70">
            Open the live console, load seven incidents that each go wrong in a different way, and see the code refuse to pay twice. It takes about three minutes.
          </p>
          <div className="mt-10 flex flex-wrap items-center justify-center gap-4">
            {health?.sandbox ? (
              <StartButton />
            ) : (
              <LinkButton href="/#console" size="lg" arrow>
                See the live board
              </LinkButton>
            )}
            <a
              href="https://github.com/AXRoux/tessera"
              className="inline-flex h-16 items-center rounded-full border border-black/25 px-7 text-[16px] tracking-[-0.01em] transition-colors hover:bg-black/5"
            >
              Read the code
            </a>
          </div>
        </div>
      </Container>
    </section>
  );
}
