import * as React from "react";
import { cn } from "@/lib/utils";

const statusColors: Record<string, string> = {
  PENDING: "bg-amber-100 text-amber-800",
  PROCESSING: "bg-blue-100 text-blue-800",
  INDEXING: "bg-indigo-100 text-indigo-800",
  COMPLETED: "bg-emerald-100 text-emerald-800",
  FAILED: "bg-red-100 text-red-800",
  INFO: "bg-blue-100 text-blue-800",
  WARN: "bg-amber-100 text-amber-800",
  CRITICAL: "bg-red-100 text-red-800"
};

export function Badge({ className, children }: React.HTMLAttributes<HTMLSpanElement>) {
  const key = typeof children === "string" ? children : "";
  return (
    <span
      className={cn(
        "inline-flex w-fit items-center rounded-md px-2 py-1 text-xs font-medium",
        statusColors[key] ?? "bg-zinc-100 text-zinc-800",
        className
      )}
    >
      {children}
    </span>
  );
}
