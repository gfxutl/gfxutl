import type { ReactElement } from "react";

export function Tooltip({ label, children }: { label: string; children: ReactElement }) {
  return <span className="ui-tooltip" data-tooltip={label}>{children}</span>;
}
