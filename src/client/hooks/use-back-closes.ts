import { useEffect, useRef } from "preact/hooks";

/** Below this width a form opens as its own page. It matches useIsPhone. */
const PHONE = "(max-width: 767px)";

/**
 * Makes a page that opens over the screen close with the phone's "back" button or back swipe.
 * It adds one step to the browser history when the page opens, and takes it away when the page closes.
 * Wide screens are left alone: there the form is a small sheet, not a page.
 */
export function useBackCloses(onClose: () => void): void {
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    if (!window.matchMedia(PHONE).matches) return;
    const mark = `${Date.now()}-${Math.random()}`;
    window.history.pushState({ formPage: mark }, "");
    const onBack = () => close.current();
    window.addEventListener("popstate", onBack);
    return () => {
      window.removeEventListener("popstate", onBack);
      // Closed with a button, not with "back": drop the step we added.
      // If the app has already moved on to another address, leave the history alone.
      if (window.history.state?.formPage === mark) window.history.back();
    };
  }, []);
}
