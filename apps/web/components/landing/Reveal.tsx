"use client";

import { useEffect } from "react";

/**
 * Fades sections in as they scroll into view. Content is visible without
 * JavaScript; the hidden start state only applies once this has run, and never
 * for visitors who prefer reduced motion.
 */
export function RevealInit() {
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || !("IntersectionObserver" in window)) return;
    const els = Array.from(document.querySelectorAll<HTMLElement>("[data-reveal]"));
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add("in");
            io.unobserve(e.target);
          }
        }
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.08 },
    );
    // Anything already on screen shows at once; the rest waits for its turn.
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (r.top < window.innerHeight) el.classList.add("in");
      else io.observe(el);
    }
    document.documentElement.classList.add("reveal-on");
    return () => io.disconnect();
  }, []);
  return null;
}
