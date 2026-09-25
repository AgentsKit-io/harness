import * as React from 'react'
import { cn } from '@/lib/utils'

export const Card = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>): React.ReactElement => (
  <div className={cn('rounded-lg border border-line-soft bg-panel shadow-sm', className)} {...props} />
)

export const CardHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>): React.ReactElement => (
  <div className={cn('flex items-baseline justify-between gap-4 border-b border-line-ghost px-5 py-4', className)} {...props} />
)

export const CardTitle = ({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>): React.ReactElement => (
  <h2 className={cn('text-sm font-semibold text-ink', className)} {...props} />
)

export const CardContent = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>): React.ReactElement => (
  <div className={cn('px-5 py-2', className)} {...props} />
)
