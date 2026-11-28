import { useEffect, useRef, useState } from "preact/hooks";
import { MessageCircle, Send, X } from "lucide-preact";
import { request, RequestError } from "./api";

interface ChatMessage { id: number; sender: "client" | "agent" | "staff" | "system"; body: string; created_at: string }
interface Chat { token: string; agent_name: string; mode: string; typing: boolean; messages: ChatMessage[] }

const KEY = "tolly_chat_token";
const POLL_MS = 3000;

function savedToken(): string | null {
  try { return window.localStorage.getItem(KEY); } catch { return null; }
}
function saveToken(token: string | null) {
  try {
    if (token) window.localStorage.setItem(KEY, token);
    else window.localStorage.removeItem(KEY);
  } catch { /* private mode: the chat still works until the page closes */ }
}

/** The chat with the shop. The browser keeps a secret token for its thread. */
export function ChatButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button" onClick={() => setOpen(true)}
        className="ml-auto flex min-h-11 shrink-0 items-center gap-2 rounded-full border border-line bg-panel px-4 text-sm font-medium text-cream hover:border-brass/60"
      >
        <MessageCircle className="h-4 w-4 text-brass" aria-hidden="true" />
        Chat
      </button>
      {open && <ChatPanel onClose={() => setOpen(false)} />}
    </>
  );
}

function ChatPanel({ onClose }: { onClose: () => void }) {
  const [token, setToken] = useState<string | null>(savedToken);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [typing, setTyping] = useState(false);
  const [name, setName] = useState("");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  const show = (chat: Chat) => {
    setMessages(chat.messages);
    setTyping(chat.typing);
    setName(chat.agent_name);
  };

  // Read the thread, then keep reading while the panel is open.
  useEffect(() => {
    if (!token) return;
    let stop = false;
    const read = async () => {
      try {
        const chat = await request<Chat>("GET", `/api/public/chat/${encodeURIComponent(token)}`);
        if (!stop) show(chat);
      } catch (err) {
        // The chat is gone (for example the shop reset it): start fresh.
        if (!stop && err instanceof RequestError && err.status === 404) { saveToken(null); setToken(null); setMessages([]); }
      }
    };
    read();
    const timer = window.setInterval(read, POLL_MS);
    return () => { stop = true; window.clearInterval(timer); };
  }, [token]);

  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [messages.length, typing]);
  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const send = async (e?: Event) => {
    e?.preventDefault();
    const message = draft.trim();
    if (!message || sending) return;
    setSending(true);
    setError(null);
    try {
      const chat = await request<Chat>("POST", "/api/public/chat/messages", { token: token ?? undefined, message });
      saveToken(chat.token);
      setToken(chat.token);
      show(chat);
      setDraft("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send. Try again.");
    } finally {
      setSending(false);
    }
  };

  return (
    <div role="dialog" aria-modal="true" aria-label="Chat with the shop" className="fixed inset-0 z-50 flex justify-center bg-ink/80">
      <div className="flex h-dvh w-full max-w-md flex-col bg-ink pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)]">
        <header className="flex items-center gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="font-display text-lg leading-tight text-cream">Chat with us</p>
            <p className="text-xs text-dim">{name ? `${name} answers first. A barber steps in when needed.` : "Ask a question or book a visit."}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close chat" className="flex h-11 w-11 items-center justify-center rounded-full text-dim hover:text-cream">
            <X className="h-5 w-5" />
          </button>
        </header>

        <div className="flex-1 space-y-2 overflow-y-auto px-4 py-4" aria-live="polite">
          {messages.length === 0 && (
            <p className="rounded-xl border border-line bg-panel px-4 py-3 text-sm text-dim">
              Hi! Ask about prices, open times, or book a visit here.
            </p>
          )}
          {messages.map((m) => <Bubble key={m.id} message={m} />)}
          {typing && <p className="px-1 text-xs text-dim">{name || "The shop"} is typing...</p>}
          <div ref={end} />
        </div>

        {error && <p role="alert" className="px-4 pb-2 text-sm text-danger">{error}</p>}
        <form onSubmit={send} className="flex items-end gap-2 border-t border-line px-4 py-3">
          <label htmlFor="chat-message" className="sr-only">Your message</label>
          <textarea
            id="chat-message" ref={input} rows={1} maxLength={2000} value={draft} placeholder="Write a message"
            onInput={(e) => setDraft(e.currentTarget.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
            className="max-h-32 min-h-12 flex-1 resize-none rounded-xl border border-line bg-panel px-4 py-3 text-base text-cream placeholder:text-dim"
          />
          <button
            type="submit" disabled={sending || !draft.trim()} aria-label="Send"
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-brass text-ink hover:bg-brass-2 disabled:bg-panel-2 disabled:text-dim"
          >
            <Send className="h-5 w-5" />
          </button>
        </form>
      </div>
    </div>
  );
}

function Bubble({ message }: { message: ChatMessage }) {
  if (message.sender === "system") {
    return <p className="py-1 text-center text-xs text-dim">{message.body}</p>;
  }
  const mine = message.sender === "client";
  return (
    <div className={`flex ${mine ? "justify-end" : "justify-start"}`}>
      <p className={`max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-4 py-2.5 text-[15px] leading-snug ${
        mine ? "rounded-br-md bg-brass text-ink" : "rounded-bl-md border border-line bg-panel text-cream"
      }`}>
        <Linked text={message.body} />
      </p>
    </div>
  );
}

/** Message text, with web links made clickable. */
function Linked({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s]+)/g);
  return (
    <>
      {parts.map((part, i) => {
        if (!/^https?:\/\//.test(part)) return part;
        const url = part.replace(/[.,!?)]+$/, "");
        return <span key={i}><a href={url} className="underline">{url}</a>{part.slice(url.length)}</span>;
      })}
    </>
  );
}
