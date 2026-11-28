import { useApp } from "../context";
import { X } from "lucide-preact";
import { Button } from "@/components/ui/button";

export function ErrorBanner() {
  const { error, setError } = useApp();
  if (!error) return null;
  return (
    <div className="fixed bottom-4 right-4 z-50 flex items-center gap-3 glass-thick rounded-2xl px-4 py-3 text-sm text-destructive">
      <span>{error}</span>
      <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setError(null)}>
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}
