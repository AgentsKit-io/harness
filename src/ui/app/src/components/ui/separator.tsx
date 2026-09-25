import * as React from 'react'
import { cn } from '@/lib/utils'

export const Separator = ({ className }: { readonly className?: string }): React.ReactElement => <div className={cn('h-px w-full bg-line-ghost', className)} />
