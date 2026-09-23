import Image from "next/image";

interface BrandMarkProps {
  size?: number;
  className?: string;
}

/**
 * Veyra icon mark. Replaces the temporary lucide "Video" camera icon
 * across the app (signup, login, dashboard headers, etc).
 */
export function BrandMark({ size = 20, className = "" }: BrandMarkProps) {
  return (
    <Image
      src="/veyra-logo.png"
      alt="Veyra"
      width={size}
      height={size}
      className={className}
      priority
    />
  );
}

export default BrandMark;
