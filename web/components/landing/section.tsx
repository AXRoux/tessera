import type { ReactNode } from "react";

/** The page's column: 1200px wide, 120px of air either side on a large screen. */
export function Container({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`mx-auto max-w-[1200px] px-6 sm:px-10 ${className}`}>{children}</div>;
}

/** A section heading: a light, tightly tracked title and one calm paragraph under it. */
export function SectionHead({
  title,
  children,
  center = false,
  id,
}: {
  title: ReactNode;
  children?: ReactNode;
  center?: boolean;
  id?: string;
}) {
  return (
    <div className={center ? "mx-auto text-center" : ""}>
      <h2 id={id} className={`heading text-balance text-[clamp(30px,4.2vw,44px)] ${center ? "mx-auto max-w-3xl" : "max-w-3xl"}`}>
        {title}
      </h2>
      {children ? (
        <p className={`mt-5 text-pretty text-[clamp(16px,1.5vw,18px)] font-light leading-[1.55] text-soft ${center ? "mx-auto max-w-2xl" : "max-w-2xl"}`}>{children}</p>
      ) : null}
    </div>
  );
}
