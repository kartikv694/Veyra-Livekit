"use client";

import { useState } from "react";
import { Lock, Eye, EyeOff } from "lucide-react";

interface PasswordFieldProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  minLength?: number;
}

/**
 * Password input with a show/hide toggle. The eye icon is black in light
 * mode and white in dark mode (not the muted gray the rest of the form
 * icons use) so it stays clearly visible against the field on either theme.
 */
export function PasswordField({ value, onChange, placeholder, minLength }: PasswordFieldProps) {
  const [visible, setVisible] = useState(false);

  return (
    <div className="flex items-center gap-2 rounded-lg border border-edge bg-surface px-3 py-2.5 focus-within:border-accent">
      <Lock size={16} className="text-muted" />
      <input
        type={visible ? "text" : "password"}
        required
        minLength={minLength}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full bg-transparent text-sm outline-none placeholder:text-muted/60"
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? "Hide password" : "Show password"}
        aria-pressed={visible}
        className="shrink-0 text-black dark:text-white"
      >
        {visible ? <EyeOff size={16} /> : <Eye size={16} />}
      </button>
    </div>
  );
}
