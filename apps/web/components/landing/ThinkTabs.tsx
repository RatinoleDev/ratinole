"use client";

import { useState, type ReactNode } from "react";

export function ThinkTabs({ tabs, views }: { tabs: { title: string; text: string }[]; views: ReactNode[] }) {
  const [on, setOn] = useState(0);
  return (
    <div className="think">
      <div className="think-nav" role="tablist" aria-label="Decision steps">
        {tabs.map((t, i) => (
          <button
            key={t.title}
            role="tab"
            aria-selected={on === i}
            className={on === i ? "on" : undefined}
            onClick={() => setOn(i)}
          >
            <em>{i + 1}</em>
            <span>
              <b>{t.title}</b>
              {t.text}
            </span>
          </button>
        ))}
      </div>
      <div className="think-view">
        {views.map((v, i) => (
          <div key={i} className={`tv${on === i ? " on" : ""}`} role="tabpanel">
            {v}
          </div>
        ))}
      </div>
    </div>
  );
}
