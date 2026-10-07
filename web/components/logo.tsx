import Image from "next/image";

interface LogoProps {
  size?: number;
  /** Use the full-resolution file (the hero). Small sizes use a 128px copy. */
  large?: boolean;
  /** Alt text. Leave empty when the name is written next to the mark. */
  label?: string;
  className?: string;
}

/**
 * The Tessera mark: a chamfered frame around a card marked 1x, a payment that happens once.
 * Served as-is: the files are already small, and this avoids depending on the image optimizer.
 */
export function Logo({ size = 32, large = false, label = "", className = "" }: LogoProps) {
  return (
    <Image
      src={large ? "/brand/tessera-mark.png" : "/brand/tessera-mark-128.png"}
      alt={label}
      width={size}
      height={size}
      unoptimized
      priority={large}
      className={`shrink-0 object-contain ${className}`}
    />
  );
}
