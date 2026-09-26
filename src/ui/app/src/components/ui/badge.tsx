import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const badgeVariants = cva('inline-flex w-fit items-center rounded-full px-2 py-1 font-mono text-[10px]', {
  variants: {
    tone: {
      neutral: 'bg-surface text-ink-muted',
      ok: 'bg-success-dim text-success',
      warn: 'bg-warning-dim text-warning',
      bad: 'bg-danger-dim text-red-300',
      drift: 'bg-drift-dim text-drift',
      system: 'bg-panel-alt text-system',
      info: 'bg-accent-dim text-accent-strong',
    },
  },
  defaultVariants: { tone: 'neutral' },
})

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export const Badge = ({ className, tone, ...props }: BadgeProps): React.ReactElement => <span className={cn(badgeVariants({ tone }), className)} {...props} />
