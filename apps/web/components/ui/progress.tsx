import { cn } from "@/lib/utils";

export function Progress({
  value,
  className,
  indicatorClassName
}: {
  value: number;
  className?: string;
  indicatorClassName?: string;
}) {
  const safe = Math.max(0, Math.min(100, value));
  return (
    <div className={cn("h-2 w-full overflow-hidden rounded-full bg-zinc-200", className)}>
      <div
        className={cn("h-full rounded-full bg-zinc-900 transition-all duration-300 ease-out", indicatorClassName)}
        style={{ width: `${safe}%` }}
      />
    </div>
  );
}
