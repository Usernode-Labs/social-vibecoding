import { DevConsolePanel } from "@/components/dev-console-panel"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { useDevConsoleContext } from "@/lib/dev-console-context"

export default function DevConsoleSheet() {
  const { clear, entries, filter, open, setFilter, setOpen } = useDevConsoleContext()
  return (
    <Sheet onOpenChange={setOpen} open={open}>
      <SheetContent className="h-[min(70dvh,42rem)] gap-0" side="bottom">
        <SheetHeader>
          <SheetTitle>Developer console</SheetTitle>
          <SheetDescription>Console output forwarded by the currently visible app or staging preview.</SheetDescription>
        </SheetHeader>
        <DevConsolePanel entries={entries} filter={filter} onClear={clear} onFilterChange={setFilter} />
      </SheetContent>
    </Sheet>
  )
}
