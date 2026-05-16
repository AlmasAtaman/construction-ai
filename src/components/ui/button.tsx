"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

type Variant =
  | "primary"
  | "accent"
  | "secondary"
  | "ghost"
  | "destructive"
  | "outline";
type Size = "default" | "sm" | "lg" | "icon" | "icon-sm";

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

const variantClasses: Record<Variant, string> = {
  primary:
    "bg-[hsl(var(--brand))] text-white hover:bg-[hsl(var(--brand-hover))] active:bg-[hsl(var(--brand-hover))] shadow-sm border border-[hsl(var(--brand-hover))]",
  accent:
    "bg-[hsl(var(--accent))] text-white hover:bg-[hsl(var(--accent-hover))] active:bg-[hsl(var(--accent-hover))] shadow-sm border border-[hsl(var(--accent-hover))]",
  secondary:
    "bg-white text-[hsl(var(--ink))] border border-[hsl(var(--line))] hover:bg-[hsl(var(--panel-2))]",
  ghost:
    "text-[hsl(var(--ink-2))] hover:bg-[hsl(var(--panel-2))] hover:text-[hsl(var(--ink))]",
  destructive:
    "bg-[hsl(var(--danger))] text-white hover:opacity-90 shadow-sm border border-[hsl(var(--danger))]",
  outline:
    "border border-[hsl(var(--line))] bg-white text-[hsl(var(--ink))] hover:bg-[hsl(var(--panel-2))]",
};

const sizeClasses: Record<Size, string> = {
  default: "h-9 px-3.5 text-[13px]",
  sm: "h-7 px-2.5 text-[12px]",
  lg: "h-11 px-5 text-[14px]",
  icon: "h-9 w-9",
  "icon-sm": "h-7 w-7",
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    { className, variant = "primary", size = "default", ...props },
    ref,
  ) {
    return (
      <button
        ref={ref}
        className={cn(
          "inline-flex items-center justify-center gap-1.5 rounded-[6px] font-medium transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--brand))] focus-visible:ring-offset-1",
          "disabled:cursor-not-allowed disabled:opacity-50",
          variantClasses[variant],
          sizeClasses[size],
          className,
        )}
        {...props}
      />
    );
  },
);
