import type { ButtonHTMLAttributes, ReactNode } from 'react';

/**
 * The four button treatments this app actually uses. Each was previously
 * written out as a literal class string in several files — the outline variant
 * alone appeared six times.
 */
export type ButtonVariant = 'primary' | 'outline' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg' | 'xl';

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-primary text-primary-foreground shadow-pop hover:bg-primary/90',
  outline: 'border border-border hover:bg-muted',
  ghost: 'hover:bg-muted',
  danger: 'text-destructive hover:bg-muted',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'px-3.5 py-2 text-sm',
  md: 'px-4 py-2 text-sm',
  lg: 'px-5 py-2.5',
  xl: 'px-5 py-3',
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  children: ReactNode;
}

export function Button({
  variant = 'primary',
  size = 'md',
  className = '',
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      type="button"
      {...props}
      className={`inline-flex items-center justify-center gap-1.5 rounded-full font-bold transition disabled:cursor-not-allowed disabled:opacity-50 ${SIZES[size]} ${VARIANTS[variant]} ${className}`}
    >
      {children}
    </button>
  );
}
