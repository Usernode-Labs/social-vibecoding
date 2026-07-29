import { Skeleton } from "@/components/ui/skeleton";

export function RouteFallback() {
  return (
    <div aria-label="Loading view" className="flex flex-1 p-4" role="status">
      <Skeleton className="h-full w-full" />
    </div>
  );
}
