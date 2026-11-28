import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import { api, UNAUTHORIZED_EVENT } from "./api";
import { Login } from "./components/login";
import { AppContext } from "./context";
import { useAppState } from "./hooks/use-app";
import { useRouter } from "./hooks/use-router";
import { useIsPhone } from "./hooks/use-is-phone";
import { backFor, screenFor } from "@/lib/phone-nav";
import { Sidebar } from "./components/sidebar";
import { Dashboard } from "./components/dashboard";
import { CalendarView } from "./components/calendar-view";
import { AppointmentList } from "./components/appointment-list";
import { AppointmentDetail } from "./components/appointment-detail";
import { ClientList } from "./components/client-list";
import { ClientDetail } from "./components/client-detail";
import { StaffList } from "./components/staff-list";
import { ServiceList } from "./components/service-list";
import { ProductList } from "./components/product-list";
import { SettingsPage } from "./components/settings";
import { Inbox } from "./components/inbox";
import { AutomationsPage } from "./components/automations";
import { AssistantPage } from "./components/assistant";
import { ReportsPage } from "./components/reports";
import { ErrorBanner } from "./components/error-banner";
import { BackLink, BookFab, MobileNav, ProfileMenu } from "./components/mobile-nav";
import { CreateAppointment } from "./components/create-appointment";

interface AuthStatus { logged_in: boolean; login_required: boolean }

/** Shows the login screen until the server says this browser is logged in. */
export function App() {
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [checkFailed, setCheckFailed] = useState(false);

  const check = useCallback(async () => {
    setCheckFailed(false);
    try {
      setAuth(await api<AuthStatus>("GET", "/api/auth/me"));
    } catch {
      setCheckFailed(true);
    }
  }, []);

  useEffect(() => {
    check();
    // Any API call that answers 401 sends us back to the login screen.
    const onUnauthorized = () => setAuth((a) => ({ logged_in: false, login_required: a?.login_required ?? true }));
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, [check]);

  const logout = useCallback(async () => {
    try {
      await api("POST", "/api/auth/logout");
    } finally {
      setAuth((a) => ({ logged_in: false, login_required: a?.login_required ?? true }));
    }
  }, []);

  if (checkFailed) {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-sm text-muted-foreground">We could not reach the server.</p>
        <button className="min-h-11 rounded-full border bg-card px-5 text-sm font-medium" onClick={check}>Try again</button>
      </div>
    );
  }
  if (!auth) {
    return <div className="flex h-dvh items-center justify-center text-muted-foreground">Loading...</div>;
  }
  if (!auth.logged_in) return <Login onLoggedIn={setAuth} />;
  return <Shell onLogout={auth.login_required ? logout : undefined} />;
}

function Shell({ onLogout }: { onLogout?: () => void }) {
  const isAgent = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    return params.has("agent") || params.get("mode") === "agent";
  }, []);

  useEffect(() => {
    if (isAgent) {
      document.documentElement.setAttribute("data-agent", "");
    }
  }, [isAgent]);

  const { view: routeView, id, home, navigate } = useRouter();
  // On a phone the app opens on the assistant. On a wide screen it opens on the dashboard.
  const isPhone = useIsPhone();
  const view = screenFor(routeView, home, isPhone);
  const appState = useAppState(isAgent, navigate);

  useEffect(() => {
    if (view === "appointments" && id) {
      appState.selectAppointment(parseInt(id, 10));
    } else if (view === "clients" && id) {
      appState.selectClient(parseInt(id, 10));
    }
  }, [view, id]); // eslint-disable-line react-hooks/exhaustive-deps

  // The round "Book" button on phones opens the booking form from the Today screen.
  // The calendar and the appointment list have their own "New booking" button.
  const [booking, setBooking] = useState(false);
  const canBook = !id && view === "dashboard";

  // Pages opened from the Profile screen show a link back to it on phones.
  const back = isPhone ? backFor(view, Boolean(id)) : null;

  // The app fills the screen and scrolls inside itself. Stop the page behind it from moving or bouncing.
  useEffect(() => {
    document.documentElement.classList.add("app-locked");
    return () => document.documentElement.classList.remove("app-locked");
  }, []);

  const renderMain = () => {
    if (view === "appointments" && id && appState.selectedAppointment) return <AppointmentDetail />;
    if (view === "clients" && id && appState.selectedClient) return <ClientDetail />;
    switch (view) {
      case "inbox": return <Inbox id={id} navigate={navigate} />;
      case "assistant": return <AssistantPage onBook={() => setBooking(true)} />;
      case "calendar": return <CalendarView />;
      case "appointments": return <AppointmentList />;
      case "clients": return <ClientList />;
      case "staff": return <StaffList />;
      case "services": return <ServiceList />;
      case "products": return <ProductList />;
      case "automations": return <AutomationsPage />;
      case "reports": return <ReportsPage />;
      case "settings": return <SettingsPage onLogout={onLogout} />;
      case "profile": return <ProfileMenu />;
      default: return <Dashboard />;
    }
  };

  return (
    <AppContext.Provider value={appState}>
      <div className="flex h-dvh flex-col overflow-hidden pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] md:flex-row print:block print:h-auto print:overflow-visible">
        <Sidebar currentView={view} onLogout={onLogout} />
        <main className={`min-h-0 min-w-0 flex-1 overscroll-contain ${view === "assistant" ? "overflow-hidden" : "overflow-auto"} pb-[5.25rem] pt-[env(safe-area-inset-top)] md:pb-0 md:pt-0 print:overflow-visible print:p-0`}>
          {appState.loading ? (
            <div className="flex h-full items-center justify-center text-muted-foreground">Loading...</div>
          ) : (
            <>
              {back && <BackLink path={back.path} label={back.label} />}
              {renderMain()}
            </>
          )}
        </main>
      </div>
      <MobileNav screen={view} />
      {canBook && !appState.loading && !booking && <BookFab onClick={() => setBooking(true)} />}
      {booking && <CreateAppointment onClose={() => setBooking(false)} />}
      <ErrorBanner />
    </AppContext.Provider>
  );
}
