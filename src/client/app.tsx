import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import { api, UNAUTHORIZED_EVENT } from "./api";
import { Login } from "./components/login";
import { AppContext } from "./context";
import { useAppState } from "./hooks/use-app";
import { useRouter } from "./hooks/use-router";
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
import { ErrorBanner } from "./components/error-banner";

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
        <button className="min-h-11 rounded-md border px-4 text-sm font-medium" onClick={check}>Try again</button>
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

  const { view, id, navigate } = useRouter();
  const appState = useAppState(isAgent, navigate);

  useEffect(() => {
    if (view === "appointments" && id) {
      appState.selectAppointment(parseInt(id, 10));
    } else if (view === "clients" && id) {
      appState.selectClient(parseInt(id, 10));
    }
  }, [view, id]); // eslint-disable-line react-hooks/exhaustive-deps

  const renderMain = () => {
    if (view === "appointments" && id && appState.selectedAppointment) return <AppointmentDetail />;
    if (view === "clients" && id && appState.selectedClient) return <ClientDetail />;
    switch (view) {
      case "calendar": return <CalendarView />;
      case "appointments": return <AppointmentList />;
      case "clients": return <ClientList />;
      case "staff": return <StaffList />;
      case "services": return <ServiceList />;
      case "products": return <ProductList />;
      default: return <Dashboard />;
    }
  };

  return (
    <AppContext.Provider value={appState}>
      <div className="flex h-dvh flex-col overflow-hidden md:flex-row">
        <Sidebar currentView={view} onLogout={onLogout} />
        <main className="min-h-0 min-w-0 flex-1 overflow-auto bg-background">
          {appState.loading ? (
            <div className="flex h-full items-center justify-center text-muted-foreground">Loading...</div>
          ) : (
            renderMain()
          )}
        </main>
      </div>
      <ErrorBanner />
    </AppContext.Provider>
  );
}
