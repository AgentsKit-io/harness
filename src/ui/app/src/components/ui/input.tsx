import * as React from 'react'
import { cn } from '@/lib/utils'

export const Input = ({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>): React.ReactElement => (
  <input className={cn('h-9 w-full min-w-0 rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink outline-none placeholder:text-ink-subtle focus-visible:ring-2 focus-visible:ring-info disabled:opacity-50', className)} {...props} />
)

export const Textarea = ({ className, ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>): React.ReactElement => (
  <textarea className={cn('min-h-24 w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink outline-none placeholder:text-ink-subtle focus-visible:ring-2 focus-visible:ring-info disabled:opacity-50', className)} {...props} />
)

export const Label = ({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>): React.ReactElement => (
  <label className={cn('text-xs font-semibold text-ink', className)} {...props} />
)
