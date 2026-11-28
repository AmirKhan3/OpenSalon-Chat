import { useEffect, useState } from "preact/hooks";

/** Below this width the app shows the phone layout. It matches Tailwind's "md". */
const PHONE = "(max-width: 767px)";

/** True while the window is as narrow as a phone. Follows the window when it changes size. */
export function useIsPhone(): boolean {
  const [isPhone, setIsPhone] = useState(() => window.matchMedia(PHONE).matches);
  useEffect(() => {
    const query = window.matchMedia(PHONE);
    const update = () => setIsPhone(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return isPhone;
}
