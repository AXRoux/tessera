"use client";

import Link from "next/link";
import { showTour } from "./tour";
import { ArrowDot } from "./ui";

/** A small pill that follows a visitor down the marketing pages and opens the control room. */
export function FloatingStart() {
  return (
    <Link
      href="/dashboard"
      onClick={showTour}
      className="fixed bottom-6 right-6 z-30 hidden h-12 items-center gap-3 rounded-full bg-blue pl-5 pr-3 text-[14px] text-white shadow-[0_10px_40px_-10px_rgb(79_79_241/0.8)] transition-colors hover:bg-[#6464ff] sm:inline-flex sm:bottom-8 sm:right-8"
    >
      Start here
      <ArrowDot />
    </Link>
  );
}
