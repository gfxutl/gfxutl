import type { InputHTMLAttributes } from "react";
import { cn } from "../../lib/utils";

export function Slider({ className, ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, "type">) {
  return <input type="range" className={cn("ui-slider", className)} {...props} />;
}
