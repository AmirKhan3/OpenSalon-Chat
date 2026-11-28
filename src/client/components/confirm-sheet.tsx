import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

interface ConfirmSheetProps {
  open: boolean;
  title: string;
  /** One short sentence that says what will happen. */
  text?: string;
  /** The word on the button that goes ahead, for example "Delete". */
  action: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Asks before something is removed. A sheet, not a browser pop-up. */
export function ConfirmSheet({ open, title, text, action, onConfirm, onCancel }: ConfirmSheetProps) {
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onCancel(); }}>
      <DialogContent className="max-w-sm" {...(text ? {} : { "aria-describedby": undefined })}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {text && <DialogDescription>{text}</DialogDescription>}
        </DialogHeader>
        <div className="flex flex-col gap-2">
          {/* Off while the sheet slides away, so a second tap cannot run it twice. */}
          <Button variant="destructive" size="lg" disabled={!open} onClick={onConfirm}>{action}</Button>
          <Button variant="outline" size="lg" onClick={onCancel}>Cancel</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
