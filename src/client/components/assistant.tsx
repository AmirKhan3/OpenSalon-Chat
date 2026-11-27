import { useEffect, useRef, useState } from "preact/hooks";
import { Bot, Send } from "lucide-preact";
import { api } from "../api";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { chatTime, type ChatMessage } from "./inbox";

interface AssistantChat { agent_name: string; configured: boolean; thinking: boolean; messages: ChatMessage[] }

const IDEAS = ["What do I have tomorrow?", "Who is my first client today?", "What times are open on Friday for a haircut?"];

/** The barber's private chat with the assistant. Clients never see it. */
export function AssistantPage() {
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
  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-3xl flex-col">
      <header className="border-b px-4 py-4">
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight"><Bot className="h-6 w-6" aria-hidden="true" /> {name}</h1>
        <p className="text-sm text-muted-foreground">Your private assistant. Clients never see this chat.</p>
      </header>

      {chat && !chat.configured && (
        <p className="border-b bg-muted px-4 py-3 text-sm">
          The assistant is off. Set AI_GATEWAY_API_KEY or ANTHROPIC_API_KEY on the server to turn it on.
        </p>
      )}

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 py-4" aria-live="polite">
        {chat && chat.messages.length === 0 && (
          <div className="space-y-3 py-6 text-center">
            <p className="text-sm text-muted-foreground">Ask about your schedule or open times.</p>
            <div className="flex flex-wrap justify-center gap-2">
              {IDEAS.map((idea) => (
                <Button key={idea} variant="outline" className="h-auto min-h-10 whitespace-normal" disabled={sending} onClick={() => send(idea)}>{idea}</Button>
              ))}
            </div>
          </div>
        )}
        {chat?.messages.map((m) => (
          m.sender === "system" ? (
            <p key={m.id} className="py-1 text-center text-xs text-muted-foreground">{m.body}</p>
          ) : (
            <div key={m.id} className={cn("flex flex-col", m.sender === "staff" ? "items-end" : "items-start")}>
              <p className={cn(
                "max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2 text-sm leading-snug",
                m.sender === "staff" ? "rounded-br-md bg-primary text-primary-foreground" : "rounded-bl-md bg-muted",
              )}>{m.body}</p>
              <span className="mt-0.5 px-1 text-[11px] text-muted-foreground">{chatTime(m.created_at)}</span>
            </div>
          )
        ))}
        {thinking && <p className="px-1 text-xs text-muted-foreground">{name} is working...</p>}
        <div ref={end} />
      </div>

      {error && <p role="alert" className="px-4 pb-2 text-sm text-destructive">{error}</p>}
      <form onSubmit={(e) => { e.preventDefault(); send(draft); }} className="flex items-end gap-2 border-t px-4 py-3">
        <label htmlFor="assistant-message" className="sr-only">Message to the assistant</label>
        <textarea
          id="assistant-message" rows={1} maxLength={2000} value={draft} placeholder={`Ask ${name}`}
          onInput={(e) => setDraft(e.currentTarget.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(draft); } }}
          className="max-h-40 min-h-11 flex-1 resize-none rounded-md border border-input bg-background px-3 py-2.5 text-base focus:outline-none focus:ring-2 focus:ring-ring sm:text-sm"
        />
        <Button type="submit" className="h-11" disabled={sending || !draft.trim()} aria-label="Send"><Send className="h-4 w-4" /></Button>
      </form>
    </div>
  );
}
