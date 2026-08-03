"use client"

import * as React from "react"
import { Toggle as TogglePrimitive } from "@base-ui/react/toggle"
import { ToggleGroup as ToggleGroupPrimitive } from "@base-ui/react/toggle-group"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"
import { toggleVariants } from "@/components/ui/toggle"

const toggleGroupSelectionVariants = cva("", {
  variants: {
    selectionVariant: {
      default: "",
      container: "border border-border bg-container p-1",
    },
  },
  defaultVariants: {
    selectionVariant: "default",
  },
})

const toggleGroupItemSelectionVariants = cva("", {
  variants: {
    selectionVariant: {
      default: "",
      container: "aria-pressed:bg-container",
    },
  },
  defaultVariants: {
    selectionVariant: "default",
  },
})

const ToggleGroupContext = React.createContext<
  VariantProps<typeof toggleVariants> & {
    selectionVariant?: "default" | "container"
    spacing?: number
    orientation?: "horizontal" | "vertical"
  }
>({
  size: "default",
  variant: "default",
  spacing: 2,
  orientation: "horizontal",
})

function ToggleGroup({
  className,
  variant,
  size,
  selectionVariant = "default",
  spacing = 2,
  orientation = "horizontal",
  children,
  ...props
}: ToggleGroupPrimitive.Props &
  VariantProps<typeof toggleVariants> & {
    selectionVariant?: "default" | "container"
    spacing?: number
    orientation?: "horizontal" | "vertical"
  }) {
  const contextValue = React.useMemo(
    () => ({ variant, size, selectionVariant, spacing, orientation }),
    [orientation, selectionVariant, size, spacing, variant]
  )

  return (
    <ToggleGroupPrimitive
      data-slot="toggle-group"
      data-variant={variant}
      data-size={size}
      data-selection-variant={selectionVariant}
      data-spacing={spacing}
      data-surface={selectionVariant === "container" ? "container" : undefined}
      data-orientation={orientation}
      style={{ "--gap": spacing } as React.CSSProperties}
      className={cn(
        "group/toggle-group flex w-fit flex-row items-center gap-[--spacing(var(--gap))] data-[spacing=0]:data-[variant=outline]:rounded-3xl data-vertical:flex-col data-vertical:items-stretch",
        toggleGroupSelectionVariants({ selectionVariant }),
        className
      )}
      {...props}
    >
      <ToggleGroupContext.Provider value={contextValue}>
        {children}
      </ToggleGroupContext.Provider>
    </ToggleGroupPrimitive>
  )
}

function ToggleGroupItem({
  className,
  children,
  variant = "default",
  size = "default",
  selectionVariant = "default",
  ...props
}: TogglePrimitive.Props &
  VariantProps<typeof toggleVariants> &
  VariantProps<typeof toggleGroupItemSelectionVariants>) {
  const context = React.useContext(ToggleGroupContext)

  return (
    <TogglePrimitive
      data-slot="toggle-group-item"
      data-variant={context.variant || variant}
      data-size={context.size || size}
      data-selection-variant={context.selectionVariant || selectionVariant}
      data-spacing={context.spacing}
      className={cn(
        "shrink-0 group-data-[spacing=0]/toggle-group:rounded-none group-data-[spacing=0]/toggle-group:px-3 group-data-[spacing=0]/toggle-group:shadow-none focus:z-10 focus-visible:z-10 group-data-[spacing=0]/toggle-group:has-data-[icon=inline-end]:pr-2.5 group-data-[spacing=0]/toggle-group:has-data-[icon=inline-start]:pl-2.5 group-data-horizontal/toggle-group:data-[spacing=0]:first:rounded-l-3xl group-data-vertical/toggle-group:data-[spacing=0]:first:rounded-t-3xl group-data-horizontal/toggle-group:data-[spacing=0]:last:rounded-r-3xl group-data-vertical/toggle-group:data-[spacing=0]:last:rounded-b-3xl group-data-horizontal/toggle-group:data-[spacing=0]:data-[variant=outline]:border-l-0 group-data-vertical/toggle-group:data-[spacing=0]:data-[variant=outline]:border-t-0 group-data-horizontal/toggle-group:data-[spacing=0]:data-[variant=outline]:first:border-l group-data-vertical/toggle-group:data-[spacing=0]:data-[variant=outline]:first:border-t",
        toggleVariants({
          variant: context.variant || variant,
          size: context.size || size,
        }),
        toggleGroupItemSelectionVariants({ selectionVariant: context.selectionVariant || selectionVariant }),
        className
      )}
      {...props}
    >
      {children}
    </TogglePrimitive>
  )
}

export { ToggleGroup, ToggleGroupItem }
