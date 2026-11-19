"use client";

/**
 * The hero's 3D crystal. Shows the still crystal at once, then swaps in the
 * live WebGL scene when three.js has loaded. Without WebGL, or if anything
 * fails, the still crystal simply stays. Visitors who prefer reduced motion get
 * one still 3D frame.
 */
import { useEffect, useRef, useState } from "react";
import type { CrystalHandle } from "../../lib/crystal3d";

function webglAvailable(): boolean {
  try {
    const c = document.createElement("canvas");
    const gl = c.getContext("webgl2") ?? c.getContext("webgl");
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
    return !!gl;
  } catch {
    return false;
  }
}

export function Crystal3D() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!webglAvailable()) return;
    const motion = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let handle: CrystalHandle | null = null;
    let cancelled = false;
    import("../../lib/crystal3d")
      .then(({ mountCrystal }) => {
        if (cancelled || !canvas.current) return;
        handle = mountCrystal(canvas.current, { motion });
        setReady(true);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      handle?.stop();
    };
  }, []);

  return (
    <div className={`crystal3d${ready ? " ready" : ""}`} aria-hidden="true">
      <img className="still" src="/crystal.svg" alt="" width={680} height={680} />
      <canvas ref={canvas} />
    </div>
  );
}
