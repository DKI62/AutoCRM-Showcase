import { createContext, use, useEffect, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';
const ClockContext = createContext(0);
export function ClockProvider({ children }: { children: ReactNode }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30000);
    const listener = AppState.addEventListener('change', value => { if (value === 'active') setNow(Date.now()); });
    return () => { clearInterval(timer); listener.remove(); };
  }, []);
  return <ClockContext value={now}>{children}</ClockContext>;
}
export function useNow(): number { return use(ClockContext); }
