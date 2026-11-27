import { Badge, BlockTitle, Fab, List, ListItem, Tabbar, TabbarLink } from "konsta/react";
import { BarChart3, Bot, CalendarDays, Clock, Ellipsis, Inbox as InboxIcon, LayoutDashboard, LogOut, Package, Plus, Settings, Sparkles, UserCog, Users, Zap } from "lucide-preact";
import { useApp } from "../context";
import type { View } from "../types";
import { useInboxCount } from "./sidebar";

/** The screens that live behind the "More" tab on phones. */
const MORE_ITEMS: { view: View; path: string; label: string; icon: typeof Bot }[] = [
  { view: "assistant", path: "/assistant", label: "Assistant", icon: Bot },
  { view: "automations", path: "/automations", label: "Automations", icon: Zap },
  { view: "appointments", path: "/appointments", label: "Appointments", icon: Clock },
  { view: "staff", path: "/staff", label: "Staff", icon: UserCog },
  { view: "services", path: "/services", label: "Services", icon: Sparkles },
  { view: "products", path: "/products", label: "Products", icon: Package },
  { view: "reports", path: "/reports", label: "Reports", icon: BarChart3 },
  { view: "settings", path: "/settings", label: "Settings", icon: Settings },
];

/** True when the "More" tab is the right one to light up for this screen. */
export function isMoreView(view: View): boolean {
  return view === "more" || MORE_ITEMS.some((item) => item.view === view);
}

/** The tab bar at the bottom of the screen on phones. */
export function MobileNav({ currentView }: { currentView: View }) {
  const { navigate } = useApp();
  const inbox = useInboxCount();

  const tabs: { key: string; path: string; label: string; icon: typeof Bot; active: boolean; badge?: number }[] = [
    { key: "today", path: "/", label: "Today", icon: LayoutDashboard, active: currentView === "dashboard" },
    { key: "calendar", path: "/calendar", label: "Calendar", icon: CalendarDays, active: currentView === "calendar" },
    { key: "inbox", path: "/inbox", label: "Inbox", icon: InboxIcon, active: currentView === "inbox", badge: inbox.waiting },
    { key: "clients", path: "/clients", label: "Clients", icon: Users, active: currentView === "clients" },
    { key: "more", path: "/more", label: "More", icon: Ellipsis, active: isMoreView(currentView) },
  ];

  return (
    <nav aria-label="Main navigation" className="md:hidden print:hidden">
      <Tabbar labels icons className="fixed bottom-0 left-0">
        {tabs.map((tab) => (
          <TabbarLink
            key={tab.key}
            active={tab.active}
            label={tab.label}
            linkProps={{ "aria-current": tab.active ? "page" : undefined }}
            icon={
              <span className="relative">
                <tab.icon className="h-6 w-6" aria-hidden="true" />
                {!!tab.badge && (
                  <Badge small colors={{ bg: inbox.needsYou ? "bg-red-500" : "bg-primary" }} className="absolute -right-2.5 -top-1">
                    {tab.badge}
                  </Badge>
                )}
              </span>
            }
            onClick={() => navigate(tab.path)}
          />
        ))}
      </Tabbar>
    </nav>
  );
}

/** The "More" screen on phones: every screen that has no tab of its own. */
export function MoreMenu({ onLogout }: { onLogout?: () => void }) {
  const { navigate, stats } = useApp();
  return (
    <div className="mx-auto max-w-xl pb-4">
      <h1 className="px-4 pt-6 text-2xl font-bold">More</h1>
      <BlockTitle>Your shop</BlockTitle>
      <List strong inset>
        {MORE_ITEMS.map((item) => (
          <ListItem
            key={item.view}
            link
            title={item.label}
            media={<item.icon className="h-5 w-5 text-primary" aria-hidden="true" />}
            after={item.view === "products" && stats.low_stock_products > 0 ? `${stats.low_stock_products} low` : undefined}
            onClick={() => navigate(item.path)}
          />
        ))}
      </List>
      {onLogout && (
        <List strong inset>
          <ListItem
            link
            chevron={false}
            title="Log out"
            media={<LogOut className="h-5 w-5 text-muted-foreground" aria-hidden="true" />}
            onClick={onLogout}
          />
        </List>
      )}
    </div>
  );
}

/** The round "Book" button above the tab bar on phones. */
export function BookFab({ onClick }: { onClick: () => void }) {
  return (
    <div className="md:hidden print:hidden">
      <Fab
        className="fixed bottom-[calc(env(safe-area-inset-bottom)+4.75rem)] right-4 z-20"
        icon={<Plus className="h-6 w-6" aria-hidden="true" />}
        text="Book"
        textPosition="after"
        onClick={onClick}
      />
    </div>
  );
}
