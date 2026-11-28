import { BarChart3, Bot, CalendarDays, ChevronLeft, ChevronRight, CircleUserRound, Clock, Inbox as InboxIcon, LayoutDashboard, Package, Plus, Settings, Sparkles, UserCog, Users, Zap } from "lucide-preact";
import { useApp } from "../context";
import type { Stats, View } from "../types";
import { cn } from "@/lib/utils";
import { PHONE_TABS, PROFILE_GROUPS, tabFor, type TabKey } from "@/lib/phone-nav";
import { useInboxCount } from "./sidebar";

const TAB_ICONS: Record<TabKey, typeof Bot> = {
  agent: Bot,
  calendar: CalendarDays,
  inbox: InboxIcon,
  profile: CircleUserRound,
};

/** The picture next to each row on the Profile screen. */
const PROFILE_ICONS: Partial<Record<View, typeof Bot>> = {
  clients: Users,
  appointments: Clock,
  dashboard: LayoutDashboard,
  services: Sparkles,
  staff: UserCog,
  products: Package,
  automations: Zap,
  reports: BarChart3,
};

/** The small number on the right of a row, or null when the row has none. */
function profileCount(view: View, stats: Stats): number | null {
  switch (view) {
    case "clients": return stats.clients;
    case "appointments": return stats.upcoming_appointments;
    case "dashboard": return stats.today_appointments;
    case "services": return stats.services;
    case "staff": return stats.staff;
    case "products": return stats.products;
    default: return null;
  }
}

/** The floating bar at the bottom of the screen on phones. `screen` is the screen now showing. */
export function MobileNav({ screen }: { screen: View }) {
  const { navigate } = useApp();
  const inbox = useInboxCount();
  const active = tabFor(screen);

  return (
    <nav
      aria-label="Main navigation"
      className="pointer-events-none fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+0.75rem)] z-30 flex justify-center md:hidden print:hidden"
    >
      <div className="pointer-events-auto flex gap-1 rounded-full glass p-1.5">
        {PHONE_TABS.map((tab) => {
          const Icon = TAB_ICONS[tab.key];
          const on = tab.key === active;
          const badge = tab.key === "inbox" ? inbox.waiting : 0;
          return (
            <button
              key={tab.key}
              type="button"
              title={tab.label}
              aria-label={badge ? `${tab.label}, ${badge} waiting` : tab.label}
              aria-current={on ? "page" : undefined}
              onClick={() => navigate(tab.path)}
              className={cn(
                "relative flex h-12 w-[3.4rem] items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                on ? "bg-card/80 text-foreground shadow-chip" : "text-muted-foreground active:bg-press",
              )}
            >
              <Icon className="h-6 w-6" strokeWidth={on ? 2.25 : 1.75} aria-hidden="true" />
              {badge > 0 && (
                <span
                  className={cn(
                    "absolute right-1.5 top-1 flex h-[1.15rem] min-w-[1.15rem] items-center justify-center rounded-full px-1 text-[11px] font-semibold leading-none text-primary-foreground",
                    inbox.needsYou ? "bg-danger" : "bg-primary",
                  )}
                  aria-hidden="true"
                >
                  {badge > 99 ? "99+" : badge}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </nav>
  );
}

/** The Profile screen on phones: a list of pages, with the settings button at the top right. */
export function ProfileMenu() {
  const { navigate, stats } = useApp();
  return (
    <div className="mx-auto max-w-xl p-4">
      <div className="flex min-h-11 items-center justify-between gap-3">
        <h1 className="text-[1.65rem] font-medium leading-tight tracking-tight">Profile</h1>
        <button
          type="button"
          onClick={() => navigate("/settings")}
          aria-label="Settings"
          title="Settings"
          className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full glass-btn focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Settings className="h-5 w-5" strokeWidth={1.75} aria-hidden="true" />
        </button>
      </div>
      {PROFILE_GROUPS.map((group) => (
        <ul key={group[0].view} className="mt-4 divide-y divide-border overflow-hidden rounded-[1.25rem] border border-hairline bg-card shadow-soft">
          {group.map((item) => {
            const Icon = PROFILE_ICONS[item.view] ?? ChevronRight;
            const count = profileCount(item.view, stats);
            const low = item.view === "products" ? stats.low_stock_products : 0;
            return (
              <li key={item.view}>
                <button
                  type="button"
                  onClick={() => navigate(item.path)}
                  className="flex min-h-[3.25rem] w-full items-center gap-3 px-4 py-2 text-left active:bg-muted focus-visible:bg-muted focus-visible:outline-none"
                >
                  <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-[0.6rem] bg-muted">
                    <Icon className="h-[1.15rem] w-[1.15rem]" strokeWidth={1.75} aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-base">{item.label}</span>
                  {low > 0 ? (
                    <span className="rounded-full bg-warning-soft px-2 py-0.5 text-xs font-medium text-warning-foreground">{low} low</span>
                  ) : count !== null && count > 0 ? (
                    <span className="text-base tabular-nums text-muted-foreground">{count}</span>
                  ) : null}
                  <ChevronRight className="h-4 w-4 flex-shrink-0 text-muted-foreground/60" aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ul>
      ))}
    </div>
  );
}

/** The link at the top of a phone screen that goes back to the screen it was opened from. */
export function BackLink({ path, label }: { path: string; label: string }) {
  const { navigate } = useApp();
  return (
    <button
      type="button"
      onClick={() => navigate(path)}
      className="-mb-2 ml-2 mt-1 flex min-h-11 items-center gap-0.5 rounded-full px-2 text-base text-primary active:bg-press focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:hidden print:hidden"
    >
      <ChevronLeft className="h-5 w-5" aria-hidden="true" />
      {label}
    </button>
  );
}

/** The round "Book" button above the bottom bar on phones. */
export function BookFab({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="fixed bottom-[calc(env(safe-area-inset-bottom)+5.5rem)] right-4 z-20 flex h-12 items-center gap-1.5 rounded-full glass-tint pl-4 pr-5 font-medium md:hidden print:hidden"
    >
      <Plus className="h-5 w-5" aria-hidden="true" />
      Book
    </button>
  );
}
