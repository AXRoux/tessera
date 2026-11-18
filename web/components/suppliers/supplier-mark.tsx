import type { SupplierBadge } from "../../../src/server/wire";

/** Marks drawn a little larger inside their tile, because the artwork itself has room around it. */
const SCALE: Record<string, number> = { framer: 0.5, langchain: 0.52, modal: 0.6, primeintellect: 0.66, replicate: 0.52, fal: 0.5 };

/**
 * A supplier's mark on its own tile, in the brand's colours. The logo is a single-colour SVG used as a mask, so it is
 * crisp at any size and takes the brand's mark colour whatever the theme.
 */
export function SupplierMark({ supplier, size = 40, className = "" }: { supplier: Pick<SupplierBadge, "id" | "name" | "tile">; size?: number; className?: string }) {
  const inner = Math.round(size * (SCALE[supplier.id] ?? 0.55));
  const light = supplier.tile.bg.toLowerCase() === "#ffffff" || supplier.tile.bg.toLowerCase().startsWith("#f");
  return (
    <span
      role="img"
      aria-label={supplier.name}
      className={`inline-flex shrink-0 items-center justify-center ${light ? "ring-1 ring-inset ring-black/10" : ""} ${className}`}
      style={{ width: size, height: size, borderRadius: Math.round(size * 0.28), background: supplier.tile.bg }}
    >
      <span
        aria-hidden
        style={{
          width: inner,
          height: inner,
          background: supplier.tile.fg,
          mask: `url(/suppliers/${supplier.id}.svg) center / contain no-repeat`,
          WebkitMask: `url(/suppliers/${supplier.id}.svg) center / contain no-repeat`,
        }}
      />
    </span>
  );
}
