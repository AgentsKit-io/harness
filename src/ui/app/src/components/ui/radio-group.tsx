import * as React from 'react'
import * as RadioGroupPrimitive from '@radix-ui/react-radio-group'
import { cn } from '@/lib/utils'

export const RadioGroup = ({ className, ...props }: React.ComponentProps<typeof RadioGroupPrimitive.Root>): React.ReactElement => (
  <RadioGroupPrimitive.Root className={cn('grid gap-2', className)} {...props} />
)

export const RadioGroupItem = ({ className, ...props }: React.ComponentProps<typeof RadioGroupPrimitive.Item>): React.ReactElement => (
  <RadioGroupPrimitive.Item className={cn('flex size-4 shrink-0 items-center justify-center rounded-full border border-line bg-surface data-[state=checked]:border-accent', className)} {...props}>
    <RadioGroupPrimitive.Indicator className="size-2 rounded-full bg-accent" />
  </RadioGroupPrimitive.Item>
)
