import type { ComponentChildren } from "preact";
import { MoreHorizontal } from "lucide-preact";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export interface RowAction {
  label: string;
  icon?: ComponentChildren;
  /** Red, and kept apart at the end of the menu. It should still ask before it removes anything. */
  destructive?: boolean;
  onSelect: () => void;
}

/**
 * The "more" button on a row or a page. Rare and risky actions live in here,
 * one step away from the main screen, so nobody hits them by mistake.
 */
export function RowMenu({ label, actions, className }: { label: string; actions: RowAction[]; className?: string }) {
  const safe = actions.filter((a) => !a.destructive);
  const risky = actions.filter((a) => a.destructive);
  // The menu closes first. Then the action runs, so a sheet it opens gets the focus cleanly.
  const pick = (action: RowAction) => () => { window.setTimeout(action.onSelect, 0); };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button" aria-label={label} title={label} onClick={(e) => e.stopPropagation()}
          className={cn("flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-press active:bg-press focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", className)}
        >
          <MoreHorizontal className="h-5 w-5" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44" onClick={(e: Event) => e.stopPropagation()}>
        {safe.map((a) => (
          <DropdownMenuItem key={a.label} className="min-h-11 gap-2 text-base md:min-h-9 md:text-sm" onSelect={pick(a)}>{a.icon}{a.label}</DropdownMenuItem>
        ))}
        {safe.length > 0 && risky.length > 0 && <DropdownMenuSeparator />}
        {risky.map((a) => (
          <DropdownMenuItem key={a.label} className="min-h-11 gap-2 text-base text-destructive focus:text-destructive md:min-h-9 md:text-sm" onSelect={pick(a)}>{a.icon}{a.label}</DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
