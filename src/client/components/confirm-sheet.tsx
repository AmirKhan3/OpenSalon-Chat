import { useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { typedMatches } from "@/lib/confirm";

interface ConfirmSheetProps {
  open: boolean;
  title: string;
  /** One short sentence that says what will happen. */
  text?: string;
  /** The word on the button that goes ahead, for example "Delete". */
  action: string;
  /** For the biggest steps: the person must type this word (a name) first. */
  typeToConfirm?: string;
  /** False for a step that removes nothing, so the button is not red. */
  destructive?: boolean;
  busy?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Asks before something is removed. A sheet, not a browser pop-up. */
export function ConfirmSheet({ open, title, text, action, typeToConfirm, destructive = true, busy, error, onConfirm, onCancel }: ConfirmSheetProps) {
  const [typed, setTyped] = useState("");
  const ready = !typeToConfirm || typedMatches(typed, typeToConfirm);
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) { setTyped(""); onCancel(); } }}>
      <DialogContent className="max-w-sm" {...(text ? {} : { "aria-describedby": undefined })}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {text && <DialogDescription>{text}</DialogDescription>}
        </DialogHeader>
        {typeToConfirm && (
          <div className="space-y-1.5">
            <label htmlFor="confirm-typed" className="text-sm">Type <span className="font-semibold">{typeToConfirm}</span> to go ahead.</label>
            <Input
              id="confirm-typed" value={typed} autoComplete="off" autoCapitalize="off" spellcheck={false} className="h-11 text-base"
              onInput={(e) => setTyped((e.currentTarget as HTMLInputElement).value)}
            />
          </div>
        )}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <div className="flex flex-col gap-2">
          {/* Off while the sheet slides away, so a second tap cannot run it twice. */}
          <Button variant={destructive ? "destructive" : "default"} size="lg" disabled={!open || !ready || busy} onClick={() => { setTyped(""); onConfirm(); }}>{action}</Button>
          <Button variant="outline" size="lg" onClick={() => { setTyped(""); onCancel(); }}>Cancel</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export interface ConfirmAsk {
  title: string;
  text?: string;
  action: string;
  typeToConfirm?: string;
  destructive?: boolean;
  /** Runs after the person says yes. If it fails, the sheet stays open and shows why. */
  run: () => void | Promise<void>;
}

/**
 * One confirm sheet for a whole screen. Call `ask(...)` from any button, and render `sheet` once.
 * Nothing is removed until the person says yes in the sheet.
 */
export function useConfirm(): [(next: ConfirmAsk) => void, ComponentChildren] {
  // The last question stays while the sheet slides away, so its words do not vanish first.
  const [asked, setAsked] = useState<ConfirmAsk | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ask = (next: ConfirmAsk) => { setAsked(next); setError(null); setOpen(true); };
  const confirm = async () => {
    if (!asked || busy) return;
    setBusy(true);
    try {
      await asked.run();
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "That did not work. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const sheet = asked ? (
    <ConfirmSheet
      open={open} title={asked.title} text={asked.text} action={asked.action} typeToConfirm={asked.typeToConfirm}
      destructive={asked.destructive} busy={busy} error={error} onConfirm={confirm}
      // The sheet stays until the step ends, so a late error cannot land in the next question.
      onCancel={() => { if (!busy) setOpen(false); }}
    />
  ) : null;
  return [ask, sheet];
}
