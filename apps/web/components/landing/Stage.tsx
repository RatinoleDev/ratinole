"use client";

import { useRef, type ReactNode } from "react";

const mix = (a: number[], b: number[], t: number) => a.map((v, i) => Math.round(v + ((b[i] ?? v) - v) * t));
const rgb = (c: number[]) => `rgb(${c.join(",")})`;

/** Stacked layers make the rounded extrusion of the 3D mark (ported from the prototype). */
function Layers() {
  const N = 44;
  const M = 12;
  const out: ReactNode[] = [];
  for (let n = 0; n < N; n++) {
    out.push(
      <i
        key={`i${n}`}
        style={{ transform: `translateZ(${n * 2}px)`, background: rgb(mix([0, 0, 0], [38, 38, 42], Math.pow(n / N, 2))) }}
      />,
    );
  }
  out.push(<i key="itop" className="top" style={{ transform: `translateZ(${N * 2}px)` }} />);
  for (let n = 1; n <= M; n++) {
    out.push(
      <b
        key={`b${n}`}
        style={{ transform: `translateZ(${N * 2 + n * 2}px)`, background: rgb(mix([110, 150, 0], [176, 222, 20], n / M)) }}
      />,
    );
  }
  out.push(<b key="btop" className="top" style={{ transform: `translateZ(${N * 2 + M * 2 + 2}px)` }} />);
  return <>{out}</>;
}

export function Stage({ floats }: { floats: ReactNode[] }) {
  const stage = useRef<HTMLDivElement>(null);
  const rig = useRef<HTMLDivElement>(null);
  return (
    <div
      className="stage"
      ref={stage}
      aria-hidden="true"
      onPointerMove={(e) => {
        const s = stage.current;
        const r = rig.current;
        if (!s || !r) return;
        const box = s.getBoundingClientRect();
        r.style.setProperty("--rz", `${((e.clientX - box.left) / box.width - 0.5) * 26}deg`);
        r.style.setProperty("--rx", `${-((e.clientY - box.top) / box.height - 0.5) * 16}deg`);
      }}
      onPointerLeave={() => {
        rig.current?.style.setProperty("--rz", "0deg");
        rig.current?.style.setProperty("--rx", "0deg");
      }}
    >
      <div className="glow" />
      <div className="ring" />
      <div className="orb" />
      <div className="shadow" />
      <div className="rig" ref={rig}>
        <div className="obj">
          <Layers />
        </div>
      </div>
      {floats.map((f, i) => (
        <div key={i} className={`float f${i + 1}`}>
          {f}
        </div>
      ))}
    </div>
  );
}
