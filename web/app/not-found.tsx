import Link from "next/link";
import { Frame, Label } from "@/components/ui";

export default function NotFound() {
  return (
    <section className="mx-auto max-w-[1440px] px-6 pt-20 sm:px-10">
      <Frame>
        <div className="hatch px-6 py-20 text-center">
          <Label>404</Label>
          <p className="mt-6 font-display text-3xl tracking-wide">No such incident</p>
          <Link href="/" className="label mt-8 inline-block text-ink underline decoration-2 underline-offset-[6px] hover:text-blue">
            Back to the board
          </Link>
        </div>
      </Frame>
    </section>
  );
}
