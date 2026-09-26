import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 outline-none focus-visible:ring-2 focus-visible:ring-info',
  {
    variants: {
      variant: {
        default: 'bg-accent text-ink-on-accent font-semibold hover:brightness-110',
        primary: 'bg-ink text-surface font-semibold hover:brightness-95',
        outline: 'border border-line bg-panel text-ink hover:border-accent',
        ghost: 'text-ink-muted hover:bg-panel-alt hover:text-ink',
        destructive: 'bg-[#dc4a4a] text-white font-semibold hover:brightness-110',
        'destructive-outline': 'border border-danger/40 text-red-300 hover:bg-danger-dim',
      },
      size: {
        default: 'h-9 px-3.5 py-2',
        sm: 'h-8 px-2.5 text-xs',
        icon: 'size-9',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
)

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  readonly asChild?: boolean
}

export const Button = ({ className, variant, size, asChild = false, ...props }: ButtonProps): React.ReactElement => {
  const Comp = asChild ? Slot : 'button'
  return <Comp className={cn(buttonVariants({ variant, size }), className)} {...props} />
}
