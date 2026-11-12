"use client";

import { usePathname } from "next/navigation";
import { showTour } from "./tour";
import { ArrowDot } from "./ui";

/** A small pill that follows the visitor down the home page and jumps back to the walkthrough. */
export function FloatingStart() {
  const pathname = usePathname();
  if (pathname !== "/") return null;
  return (
    <a
      href="/#start"
      onClick={showTour}
      className="fixed bottom-6 right-6 z-30 hidden sm:inline-flex h-12 items-center gap-3 rounded-full bg-blue pl-5 pr-3 text-[14px] text-white shadow-[0_10px_40px_-10px_rgb(79_79_241/0.8)] transition-colors hover:bg-[#6464ff] sm:bottom-8 sm:right-8"
    >
      Start here
      <ArrowDot />
    </a>
  );
}
