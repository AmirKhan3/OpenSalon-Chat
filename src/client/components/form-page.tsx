import type { ComponentChildren } from "preact";
import { ChevronLeft } from "lucide-preact";
import { cn } from "@/lib/utils";
import { useBackCloses } from "../hooks/use-back-closes";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";

interface FormPageProps {
  title: string;
  /** One short line under the title. */
  description?: string;
  onClose: () => void;
  /** The buttons at the bottom, for example Cancel and Save. */
  footer?: ComponentChildren;
  /** Extra classes for the wide-screen sheet, for example its width. */
  className?: string;
  children: ComponentChildren;
}

/**
 * A form for adding or changing one thing.
 * Phones: its own full page with a back button at the top. The fields scroll and the buttons stay at the bottom.
 * Wide screens: a centered sheet, as before.
 */
export function FormPage({ title, description, onClose, footer, className, children }: FormPageProps) {
  useBackCloses(onClose);
  return (
    <Dialog open onOpenChange={(open: boolean) => { if (!open) onClose(); }}>
      <DialogContent className={cn("page-sheet max-w-md", className)} {...(description ? {} : { "aria-describedby": undefined })}>
        <div className="page-sheet-head">
          <button
            type="button"
            onClick={onClose}
            aria-label="Back"
            className="page-sheet-back h-11 w-11 flex-shrink-0 items-center justify-center rounded-full glass-btn focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronLeft className="h-5 w-5" aria-hidden="true" />
          </button>
          <div className="min-w-0 space-y-1.5">
            <DialogTitle className="leading-tight">{title}</DialogTitle>
            {description && <DialogDescription>{description}</DialogDescription>}
          </div>
        </div>
        <div className="page-sheet-body">{children}</div>
        {footer && <div className="page-sheet-foot">{footer}</div>}
      </DialogContent>
    </Dialog>
  );
}
