import { useEffect, useRef, useState } from "preact/hooks";
import { ArrowUp, Bot, Plus } from "lucide-preact";
import { api } from "../api";
import { cn } from "@/lib/utils";
import { startsNewMoment } from "@/lib/phone-nav";
import { chatTime, type ChatMessage } from "./inbox";

interface AssistantChat { agent_name: string; configured: boolean; thinking: boolean; messages: ChatMessage[] }

const IDEAS = [
  "Add a new service","What do I have tomorrow?", "Who is my first client today?", "What times are open on Friday for a haircut?"];

/** The barber's private chat with the assistant. Clients never see it. `onBook` opens the booking form. */
export function AssistantPage({ onBook }: { onBook?: () => void }) {
  const [chat, setChat] = useState<AssistantChat | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const end = useRef<HTMLDivElement>(null);

  const thinking = chat?.thinking ?? false;
  useEffect(() => {
    let stop = false;
    const read = async () => {
      try {
        const next = await api<AssistantChat>("GET", "/api/assistant");
        if (!stop) { setChat(next); setError(null); }
      } catch (err) {
        if (!stop) setError(err instanceof Error ? err.message : "Could not load the chat.");
      }
    };
    read();
    // Look often while the assistant works, rarely when it is idle.
    const timer = window.setInterval(read, thinking ? 1500 : 10000);
    return () => { stop = true; window.clearInterval(timer); };
  }, [thinking]);

  const count = chat?.messages.length ?? 0;
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [count, thinking]);

  const send = async (text: string) => {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    setError(null);
    try {
      setChat(await api<AssistantChat>("POST", "/api/assistant/messages", { body }));
      setDraft("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send. Try again.");
    } finally {
      setSending(false);
    }
  };

  const name = chat?.agent_name ?? "Assistant";
  const messages = chat?.messages ?? [];
  // The time shows above a message only when the chat starts or picks up again after a gap.
  const spoken = messages.filter((m) => m.sender !== "system");

  return (
    <div className="relative mx-auto flex h-full min-h-0 w-full max-w-3xl flex-col">
      {/* Wide screens: a plain header. */}
      <header className="hidden px-4 pb-2 pt-6 md:block">
        <h1 className="flex items-center gap-2 text-[1.65rem] font-medium leading-tight tracking-tight"><Bot className="h-6 w-6" aria-hidden="true" /> {name}</h1>
        <p className="text-sm text-muted-foreground">Your private assistant. Clients never see this chat.</p>
      </header>

      {/* Phones: the name floats over the chat, and the chat scrolls under it. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex h-28 items-start justify-center bg-gradient-to-b from-background via-background/90 to-transparent px-4 pt-3 md:hidden">
        <h1 className="flex flex-col items-center gap-1">
          <span className="relative flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-b from-primary to-primary-strong text-lg font-medium text-primary-foreground shadow-action" aria-hidden="true">
            {name.trim().charAt(0).toUpperCase() || "A"}
            {thinking && <span className="absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 animate-pulse motion-reduce:animate-none rounded-full border-2 border-card bg-success" />}
          </span>
          <span className="-mt-3 relative rounded-full glass px-2.5 py-0.5 text-xs font-medium">{name}</span>
          {thinking && <span className="text-xs font-normal text-muted-foreground">Working...</span>}
        </h1>
        {onBook && (
          <button
            type="button"
            onClick={onBook}
            aria-label="New booking"
            title="New booking"
            className="pointer-events-auto absolute right-4 top-3 flex h-11 w-11 items-center justify-center rounded-full glass-btn focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Plus className="h-5 w-5" aria-hidden="true" />
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-4 pb-4 pt-28 md:pt-4" aria-live="polite">
        <p className="pb-2 text-center text-xs text-muted-foreground md:hidden">Only you see this chat. Clients never do.</p>

        {chat && !chat.configured && (
          <p className="rounded-[1.25rem] border border-hairline bg-card px-4 py-3 text-sm shadow-soft">
            {name} is off right now. Ask the person who set up your app to turn it on.
          </p>
        )}

        {chat && messages.length === 0 && (
          <div className="pt-4">
            <p className="text-2xl font-medium tracking-tight">What do you need?</p>
            <p className="mt-1 text-sm text-muted-foreground">Ask about your schedule or open times.</p>
            <ul className="mt-5 divide-y divide-border overflow-hidden rounded-[1.25rem] border border-hairline bg-card shadow-soft">
              {IDEAS.map((idea) => (
                <li key={idea}>
                  <button type="button" disabled={sending} onClick={() => send(idea)} className="flex min-h-14 w-full items-center justify-between gap-3 px-4 py-3 text-left text-primary active:bg-muted disabled:opacity-50">
                    {idea}
                    <ArrowUp className="h-4 w-4 flex-shrink-0 opacity-60" aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {messages.map((m) => {
          if (m.sender === "system") {
            return <p key={m.id} className="py-1 text-center text-xs text-muted-foreground">{m.body}</p>;
          }
          const before = spoken[spoken.indexOf(m) - 1];
          const mine = m.sender === "staff";
          return (
            <div key={m.id}>
              {startsNewMoment(before?.created_at, m.created_at) && (
                <p className="pb-1 pt-3 text-center text-xs text-muted-foreground">{chatTime(m.created_at)}</p>
              )}
              <div className={cn("flex", mine ? "justify-end" : "justify-start")}>
                <p className={cn(
                  "max-w-[85%] whitespace-pre-wrap break-words rounded-[1.35rem] px-4 py-2.5 text-base leading-snug",
                  mine ? "rounded-br-md bg-bubble" : "rounded-bl-md bg-muted",
                )}>{m.body}</p>
              </div>
            </div>
          );
        })}
        {thinking && (
          <div className="flex justify-start" role="status">
            <span className="sr-only">{name} is working...</span>
            <span className="typing-dots flex h-10 items-center gap-1 rounded-[1.35rem] rounded-bl-md bg-muted px-4" aria-hidden="true"><i /><i /><i /></span>
          </div>
        )}
        <div ref={end} />
      </div>

      {error && <p role="alert" className="px-4 pb-2 text-sm text-destructive">{error}</p>}
      <form
        onSubmit={(e) => { e.preventDefault(); send(draft); }}
        className="mx-3 mb-2 flex items-end gap-1 rounded-[1.75rem] glass p-1.5 focus-within:ring-2 focus-within:ring-ring md:mb-4"
      >
        <label htmlFor="assistant-message" className="sr-only">Message to the assistant</label>
        <textarea
          id="assistant-message" rows={1} maxLength={2000} value={draft} placeholder={`Message ${name}`}
          onInput={(e) => setDraft(e.currentTarget.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(draft); } }}
          className="max-h-40 min-h-11 flex-1 resize-none bg-transparent px-3 py-2.5 text-base placeholder:text-muted-foreground focus:outline-none"
        />
        <button
          type="submit"
          disabled={sending || !draft.trim()}
          aria-label="Send"
          className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full glass-tint disabled:pointer-events-none disabled:bg-none disabled:bg-press disabled:[--glass-bg-solid:var(--press)] disabled:text-muted-foreground disabled:shadow-none disabled:inset-shadow-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          <ArrowUp className="h-5 w-5" aria-hidden="true" />
        </button>
      </form>
    </div>
  );
}
