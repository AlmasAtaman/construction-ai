"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  function Input({ className, ...props }, ref) {
    return (
      <input
        ref={ref}
        className={cn(
          "flex h-9 w-full rounded-[6px] border border-[hsl(var(--line))] bg-white px-3 text-[13px] text-[hsl(var(--ink))]",
          "placeholder:text-[hsl(var(--ink-3))]",
          "focus-visible:outline-none focus-visible:border-[hsl(var(--brand))] focus-visible:ring-2 focus-visible:ring-[hsl(var(--brand-soft))]",
          "disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        {...props}
      />
    );
  },
);
