"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/** The reasoning tape: steps appear one by one when scrolled into view (prototype behaviour). */
export function TapeBody({ steps, verdict }: { steps: { k: string; v: ReactNode }[]; verdict: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(0);
  const [done, setDone] = useState(false);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (still) {
      // No animation: show every step and the verdict at once.
      setShown(steps.length);
      setDone(true);
      return;
    }
    const timers: ReturnType<typeof setTimeout>[] = [];
    const play = () => {
      steps.forEach((_, i) => timers.push(setTimeout(() => setShown((s) => Math.max(s, i + 1)), still ? 0 : 200 + i * 750)));
      timers.push(setTimeout(() => setDone(true), still ? 0 : 200 + steps.length * 750));
    };
    if (!("IntersectionObserver" in window)) {
      play();
      return () => timers.forEach(clearTimeout);
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          play();
          io.disconnect();
        }
      },
      { threshold: 0.3 },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      timers.forEach(clearTimeout);
    };
  }, [steps]);

  return (
    <>
      <div className="tape-body" ref={box}>
        {steps.map((s, i) => (
          <div key={s.k} className={`step${i < shown ? " on" : ""}`}>
            <div className="k">{s.k}</div>
            <div className="v">{s.v}</div>
          </div>
        ))}
      </div>
      <div className={`verdict${done ? "" : " hide"}`}>{verdict}</div>
    </>
  );
}
