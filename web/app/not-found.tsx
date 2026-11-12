import Link from "next/link";
import { Logo } from "@/components/logo";
import { Frame, Label } from "@/components/ui";

export default function NotFound() {
  return (
    <section className="mx-auto max-w-[1200px] px-6 pt-20 sm:px-10">
      <Frame>
        <div className="hatch px-6 py-20 text-center">
          <Logo size={44} className="mx-auto mb-6" />
          <Label>404</Label>
          <p className="heading mt-6 text-3xl">Incident not found</p>
          <p className="mx-auto mt-4 max-w-md text-sm text-muted">It may have been removed, or the link may be wrong.</p>
          <Link href="/" className="label mt-8 inline-block text-ink underline decoration-2 underline-offset-[6px] hover:text-sky">
            Back to the board
          </Link>
        </div>
      </Frame>
    </section>
  );
}
