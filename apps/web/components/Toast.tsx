"use client";

import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";

const ToastContext = createContext<(text: string) => void>(() => {});

export function useToast() {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [text, setText] = useState("");
  const [on, setOn] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toast = useCallback((t: string) => {
    setText(t);
    setOn(true);
    if (timer.current) clearTimeout(timer.current);
    // Longer messages stay up longer, so they can be read.
    timer.current = setTimeout(() => setOn(false), Math.min(9000, 2600 + Math.max(0, t.length - 30) * 45));
  }, []);
  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div className={`toast${on ? " on" : ""}`} role="status" aria-live="polite">
        {text}
      </div>
    </ToastContext.Provider>
  );
}
