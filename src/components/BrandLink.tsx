"use client";

import Link from "next/link";
import BrandMark from "./BrandMark";

interface BrandLinkProps {
  size?: number;
  textClassName?: string;
}

/**
 * Logo + "Veyra" wordmark, wrapped in a link back to the landing page ("/").
 * Used everywhere the brand mark appears in a header, so clicking the logo
 * or the name always takes you home, consistently across the app.
 */
export function BrandLink({
  size = 22,
  textClassName = "font-display text-lg font-semibold",
}: BrandLinkProps) {
  return (
    <Link href="/" className="flex items-center gap-2 transition-opacity hover:opacity-80">
      <BrandMark size={size} />
      <span className={textClassName}>Veyra</span>
    </Link>
  );
}
