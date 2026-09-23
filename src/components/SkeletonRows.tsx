interface SkeletonRowsProps {
  /** How many placeholder rows to show. */
  count?: number;
}

/**
 * Pulsing gray placeholder rows shown while a list is loading — e.g. the
 * dashboard's meetings list before the first fetch resolves. Roughly
 * matches the shape of an actual meeting row (a title-width bar plus a
 * shorter subtitle-width bar) so the layout doesn't visibly jump once
 * real content replaces it.
 */
export function SkeletonRows({ count = 3 }: SkeletonRowsProps) {
  return (
    <ul className="space-y-2" aria-label="Loading" aria-busy="true">
      {Array.from({ length: count }).map((_, i) => (
        <li
          key={i}
          className="flex items-center justify-between gap-3 rounded-lg border border-edge px-4 py-3"
        >
          <div className="flex-1 space-y-2">
            <div className="h-3.5 w-2/5 animate-pulse rounded bg-surface2" />
            <div className="h-3 w-1/4 animate-pulse rounded bg-surface2" />
          </div>
          <div className="h-7 w-20 shrink-0 animate-pulse rounded-lg bg-surface2" />
        </li>
      ))}
    </ul>
  );
}
