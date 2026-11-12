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
          <p className="heading mt-6 text-3xl">Nothing here</p>
          <p className="mx-auto mt-4 max-w-md text-sm text-muted">The incident may have been removed, or the link may be wrong.</p>
          <p className="mt-8 flex flex-wrap items-center justify-center gap-6">
            <Link href="/dashboard" className="label text-ink underline decoration-2 underline-offset-[6px] hover:text-sky">
              Back to the control room
            </Link>
            <Link href="/" className="label text-muted underline decoration-white/20 underline-offset-[6px] hover:text-white">
              The site
            </Link>
          </p>
        </div>
      </Frame>
    </section>
  );
}
