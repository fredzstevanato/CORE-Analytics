import type { HTMLAttributes } from "react";
import { cn } from "../lib";

export function Card(props: HTMLAttributes<HTMLDivElement>) {
  const { className, ...rest } = props;
  return <div className={cn("rounded-lg border border-zinc-200 bg-white p-4", className)} {...rest} />;
}
