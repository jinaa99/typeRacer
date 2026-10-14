import { createContext, useContext, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** DOM node in the app top bar where the current screen can render actions. */
export const TopbarSlotContext = createContext<HTMLElement | null>(null);

export function TopbarActions({ children }: { children: ReactNode }) {
  const el = useContext(TopbarSlotContext);
  return el ? createPortal(children, el) : null;
}
