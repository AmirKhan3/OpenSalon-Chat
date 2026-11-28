import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { Bot, ChevronLeft, MessageSquare, Smartphone, StickyNote, UserRound } from "lucide-preact";
import { api } from "../api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface ChatThread {
  id: number; channel: "web" | "sms"; display_name: string; phone: string | null; client_id: number | null;
  mode: "agent" | "human"; needs_attention: boolean; staff_unread: number; last_message_at: string | null; preview: string;
}
export interface ChatMessage { id: number; sender: "client" | "agent" | "staff" | "system" | "note"; body: string; delivery_status: string; created_at: string }
interface ThreadList { threads: ChatThread[]; unread: number; needs_attention: number }
interface ThreadDetail { thread: ChatThread; typing: boolean; messages: ChatMessage[] }

const LIST_POLL_MS = 5000;
const THREAD_POLL_MS = 3000;

/** Timestamps are UTC text from the server. */
export function chatTime(utc: string | null): string {
  if (!utc) return "";
  const date = new Date(utc.includes("T") ? utc : `${utc.replace(" ", "T")}Z`);
  if (Number.isNaN(date.getTime())) return "";
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay
    ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : date.toLocaleDateString([], { month: "short", day: "numeric" });
}

/** The inbox: every chat with a client. The barber reads and answers here. */
export function Inbox({ id, navigate }: { id: string | null; navigate: (to: string) => void }) {
  const [list, setList] = useState<ThreadList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const selected = id && /^\d+$/.test(id) ? Number(id) : null;

  const loadList = useCallback(async () => {
    try {
      setList(await api<ThreadList>("GET", "/api/chat/threads"));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the inbox.");
    }
  }, []);

  useEffect(() => {
    loadList();
    const timer = window.setInterval(loadList, LIST_POLL_MS);
    return () => window.clearInterval(timer);
  }, [loadList]);

  return (
    <div className="flex h-full min-h-0">
      <section aria-label="Chats" className={cn("min-h-0 w-full flex-col border-r md:flex md:w-80 md:shrink-0", selected ? "hidden" : "flex")}>
        <div className="flex items-center justify-between gap-2 border-b px-4 py-4">
          <h1 className="text-[1.65rem] font-medium leading-tight tracking-tight">Inbox</h1>
          {list && list.needs_attention > 0 && <Badge variant="destructive">{list.needs_attention} need you</Badge>}
        </div>
        {error && <p className="p-4 text-sm text-destructive">{error}</p>}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {list && list.threads.length === 0 && (
            <p className="p-6 text-sm text-muted-foreground">No chats yet. Messages from clients show up here.</p>
          )}
          {list?.threads.map((t) => (
            <button
              key={t.id} onClick={() => navigate(`/inbox/${t.id}`)} aria-current={selected === t.id ? "true" : undefined}
              className={cn(
                "flex w-full items-start gap-3 border-b px-4 py-3 text-left transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                selected === t.id && "bg-accent",
              )}
            >
              <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                {t.channel === "sms" ? <Smartphone className="h-4 w-4" /> : <MessageSquare className="h-4 w-4" />}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className={cn("truncate text-sm", t.staff_unread > 0 ? "font-semibold" : "font-medium")}>{t.display_name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{chatTime(t.last_message_at)}</span>
                </div>
                <p className={cn("truncate text-sm", t.staff_unread > 0 ? "text-foreground" : "text-muted-foreground")}>{t.preview || " "}</p>
                <div className="mt-1 flex flex-wrap gap-1">
                  {t.needs_attention && <Badge variant="destructive" className="h-5 px-1.5 text-xs">Needs you</Badge>}
                  {t.staff_unread > 0 && <Badge className="h-5 px-1.5 text-xs">{t.staff_unread} new</Badge>}
                  {t.mode === "human" && !t.needs_attention && <Badge variant="secondary" className="h-5 px-1.5 text-xs">You have it</Badge>}
                </div>
              </div>
            </button>
          ))}
        </div>
      </section>

      <section aria-label="Chat" className={cn("min-h-0 min-w-0 flex-1 flex-col md:flex", selected ? "flex" : "hidden")}>
        {selected ? (
          <ThreadView key={selected} id={selected} onBack={() => navigate("/inbox")} onChanged={loadList} />
        ) : (
          <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">Pick a chat to read it.</div>
        )}
      </section>
    </div>
  );
}

function ThreadView({ id, onBack, onChanged }: { id: number; onBack: () => void; onChanged: () => void }) {
  const [detail, setDetail] = useState<ThreadDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [asNote, setAsNote] = useState(false);
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let stop = false;
    const read = async (markRead: boolean) => {
      try {
        const d = await api<ThreadDetail>(markRead ? "POST" : "GET", `/api/chat/threads/${id}${markRead ? "/read" : ""}`);
        if (stop) return;
        setDetail(d);
        setError(null);
        // New messages arrived while the chat is open: they are read.
        if (!markRead && d.thread.staff_unread > 0) read(true);
        if (markRead) onChanged();
      } catch (err) {
        if (!stop) setError(err instanceof Error ? err.message : "Could not load the chat.");
      }
    };
    read(true);
    const timer = window.setInterval(() => read(false), THREAD_POLL_MS);
    return () => { stop = true; window.clearInterval(timer); };
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const count = detail?.messages.length ?? 0;
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [count, detail?.typing]);

  const act = async (path: string, body?: unknown) => {
    setBusy(true);
    setError(null);
    try {
      setDetail(await api<ThreadDetail>("POST", `/api/chat/threads/${id}/${path}`, body));
      onChanged();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "That did not work. Try again.");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const send = async (e?: Event) => {
    e?.preventDefault();
    const body = draft.trim();
    if (!body || busy) return;
    if (await act("messages", { body, note: asNote })) setDraft("");
  };

  if (!detail) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        <Button variant="ghost" className="mb-2 md:hidden" onClick={onBack}><ChevronLeft className="h-4 w-4" /> Inbox</Button>
        <p className={error ? "text-destructive" : ""}>{error ?? "Loading..."}</p>
      </div>
    );
  }
  const { thread } = detail;
  const human = thread.mode === "human";

  return (
    <>
      <header className="flex flex-wrap items-center gap-2 border-b px-3 py-3 sm:px-4">
        <Button variant="ghost" size="icon" className="h-11 w-11 md:hidden" aria-label="Back to the inbox" onClick={onBack}>
          <ChevronLeft className="h-5 w-5" />
        </Button>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-semibold">{thread.display_name}</h2>
          <p className="truncate text-xs text-muted-foreground">
            {thread.channel === "sms" ? "Text messages" : "Web chat"}{thread.phone ? ` · ${thread.phone}` : ""}
            {" · "}{human ? "You answer this chat" : "The assistant answers this chat"}
          </p>
        </div>
        {human ? (
          <Button variant="outline" disabled={busy} onClick={() => act("handback")}><Bot className="h-4 w-4" /> Hand back to AI</Button>
        ) : (
          <Button disabled={busy} onClick={() => act("takeover")}><UserRound className="h-4 w-4" /> Take over</Button>
        )}
      </header>

      {thread.needs_attention && (
        <p className="border-b bg-destructive/10 px-4 py-2 text-sm text-destructive">This client is waiting for a barber. Write a reply below.</p>
      )}

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-4 sm:px-4" aria-live="polite">
        {detail.messages.map((m) => <StaffBubble key={m.id} message={m} />)}
        {detail.typing && <p className="px-1 text-xs text-muted-foreground">The assistant is writing...</p>}
        <div ref={end} />
      </div>

      {error && <p role="alert" className="px-4 pb-2 text-sm text-destructive">{error}</p>}
      <form onSubmit={send} className={cn("space-y-2 border-t px-3 py-3 sm:px-4", asNote && "bg-warning-soft")}>
        <label htmlFor="inbox-reply" className="sr-only">{asNote ? "Staff note" : "Reply"}</label>
        <textarea
          id="inbox-reply" rows={2} maxLength={2000} value={draft}
          placeholder={asNote ? "Staff note. The client never sees it." : human ? "Write a reply" : "Write a reply. The assistant stops when you send it."}
          onInput={(e) => setDraft(e.currentTarget.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } }}
          className="w-full resize-none rounded-xl border border-input bg-card px-3 py-2 text-base focus:outline-none focus:ring-2 focus:ring-ring sm:text-sm"
        />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <label className="flex min-h-10 items-center gap-2 text-sm">
            <input type="checkbox" className="h-5 w-5 accent-primary md:h-4 md:w-4" checked={asNote} onChange={(e) => setAsNote(e.currentTarget.checked)} />
            Staff note (hidden from the client)
          </label>
          <Button type="submit" disabled={busy || !draft.trim()}>{asNote ? "Save note" : "Send"}</Button>
        </div>
      </form>
    </>
  );
}

function StaffBubble({ message }: { message: ChatMessage }) {
  if (message.sender === "system") {
    return <p className="py-1 text-center text-xs text-muted-foreground">Shown to the client: {message.body}</p>;
  }
  if (message.sender === "note") {
    return (
      <div className="mx-auto flex max-w-[90%] items-start gap-2 rounded-2xl border border-warning-border bg-warning-soft px-3 py-2 text-sm text-warning-foreground">
        <StickyNote className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <p className="min-w-0 whitespace-pre-wrap break-words"><span className="font-medium">Staff note. </span>{message.body}</p>
      </div>
    );
  }
  const theirs = message.sender === "client";
  const failed = message.delivery_status.startsWith("failed");
  return (
    <div className={cn("flex flex-col", theirs ? "items-start" : "items-end")}>
      <p className={cn(
        "max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2 text-sm leading-snug",
        theirs ? "rounded-bl-md bg-muted" : message.sender === "agent" ? "rounded-br-md bg-secondary text-secondary-foreground" : "rounded-br-md bg-primary text-primary-foreground",
        failed && "ring-2 ring-destructive",
      )}>
        {message.body}
      </p>
      <span className={cn("mt-0.5 px-1 text-xs", failed ? "text-destructive" : "text-muted-foreground")}>
        {theirs ? "Client" : message.sender === "agent" ? "Assistant" : "You"} · {chatTime(message.created_at)}
        {failed ? ` · Not delivered${message.delivery_status.includes(":") ? ` (${message.delivery_status.split(":").slice(1).join(":").trim()})` : ""}` : ""}
      </span>
    </div>
  );
}
