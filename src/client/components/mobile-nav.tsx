import { BarChart3, Bot, CalendarDays, ChevronRight, Clock, Ellipsis, Inbox as InboxIcon, LayoutDashboard, LogOut, Package, Plus, Settings, Sparkles, UserCog, Users, Zap } from "lucide-preact";
import { useApp } from "../context";
import type { View } from "../types";
import { cn } from "@/lib/utils";
import { PHONE_TABS, tabFor, type TabKey } from "@/lib/phone-nav";
import { useInboxCount } from "./sidebar";

const TAB_ICONS: Record<TabKey, typeof Bot> = {
  agent: Bot,
  calendar: CalendarDays,
  inbox: InboxIcon,
  clients: Users,
  more: Ellipsis,
};

/** The screens that live behind the "More" tab on phones. */
const MORE_ITEMS: { view: View; path: string; label: string; about: string; icon: typeof Bot }[] = [
  { view: "dashboard", path: "/dashboard", label: "Today", about: "Today's bookings and numbers", icon: LayoutDashboard },
  { view: "automations", path: "/automations", label: "Automations", about: "Texts that send themselves", icon: Zap },
  { view: "appointments", path: "/appointments", label: "Appointments", about: "Every booking, past and next", icon: Clock },
  { view: "staff", path: "/staff", label: "Staff", about: "Barbers and their hours", icon: UserCog },
  { view: "services", path: "/services", label: "Services", about: "What you offer, prices and times", icon: Sparkles },
  { view: "products", path: "/products", label: "Products", about: "Stock you sell in the shop", icon: Package },
  { view: "reports", path: "/reports", label: "Reports", about: "Income, taxes and progress", icon: BarChart3 },
  { view: "settings", path: "/settings", label: "Settings", about: "Shop, texts and payments", icon: Settings },
];

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

/** The "More" screen on phones: every screen that has no tab of its own. */
export function MoreMenu({ onLogout }: { onLogout?: () => void }) {
  const { navigate, stats } = useApp();
  return (
    <div className="mx-auto max-w-xl p-4">
      <h1 className="flex min-h-11 items-center text-[1.65rem] font-medium leading-tight tracking-tight">Your shop</h1>
      <ul className="mt-3 divide-y divide-border overflow-hidden rounded-[1.25rem] border border-hairline bg-card shadow-soft">
        {MORE_ITEMS.map((item) => (
          <li key={item.view}>
            <button type="button" onClick={() => navigate(item.path)} className="flex min-h-16 w-full items-center gap-3.5 px-4 py-3 text-left active:bg-muted">
              <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-muted">
                <item.icon className="h-5 w-5" strokeWidth={1.75} aria-hidden="true" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-medium leading-tight">{item.label}</span>
                <span className="block text-sm text-muted-foreground">{item.about}</span>
              </span>
              {item.view === "products" && stats.low_stock_products > 0 && (
                <span className="rounded-full bg-warning-soft px-2 py-0.5 text-xs font-medium text-warning-foreground">{stats.low_stock_products} low</span>
              )}
              <ChevronRight className="h-4 w-4 flex-shrink-0 text-muted-foreground/60" aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
      {onLogout && (
        <button type="button" onClick={onLogout} className="mt-4 flex min-h-14 w-full items-center gap-3.5 rounded-[1.25rem] border border-hairline bg-card px-4 text-left text-muted-foreground shadow-soft active:bg-muted">
          <LogOut className="ml-2.5 mr-2.5 h-5 w-5" strokeWidth={1.75} aria-hidden="true" />
          <span className="font-medium">Log out</span>
        </button>
      )}
    </div>
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
