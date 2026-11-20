"use client";

/**
 * The 3D robot helper. A drawn robot shows at once; the live WebGL robot takes over when three.js has loaded.
 * Without WebGL, or if anything fails, the drawn robot simply stays. Visitors who prefer reduced motion get a
 * still pose for each mood.
 */
import { useEffect, useRef, useState } from "react";
import type { RobotHandle, RobotMood } from "../../lib/robot3d";

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

/** The same robot, drawn flat: the placeholder and the no-WebGL fallback. */
function RobotStill({ mood }: { mood: RobotMood }) {
  const eye = mood === "confused" ? "#FFC857" : "#C6F432";
  return (
    <svg className={`still ${mood}`} viewBox="0 0 200 220" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="rs-c" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#F1EEE6" />
          <stop offset="1" stopColor="#A8A499" />
        </linearGradient>
      </defs>
      <ellipse cx="100" cy="207" rx="34" ry="5" fill="none" stroke="#C6F432" strokeWidth="2" opacity=".5" />
      <path d="M100 30V14" stroke="#2A2A2D" strokeWidth="4" strokeLinecap="round" />
      <circle cx="100" cy="11" r="7" fill="#C6F432" />
      <rect x="27" y="62" width="14" height="30" rx="7" fill="#2A2A2D" />
      <rect x="159" y="62" width="14" height="30" rx="7" fill="#2A2A2D" />
      <rect x="36" y="30" width="128" height="94" rx="38" fill="url(#rs-c)" />
      <rect x="51" y="48" width="98" height="56" rx="16" fill="#08080A" />
      {mood === "happy" ? (
        <path d="M68 80a10 10 0 0 1 20 0M112 80a10 10 0 0 1 20 0" fill="none" stroke={eye} strokeWidth="6" strokeLinecap="round" />
      ) : mood === "sleeping" ? (
        <path d="M68 78h20M112 78h20" stroke={eye} strokeWidth="5" strokeLinecap="round" opacity=".5" />
      ) : (
        <>
          <rect x="71" y="62" width="14" height="28" rx="7" fill={eye} />
          <rect x="115" y="62" width="14" height="28" rx="7" fill={eye} />
        </>
      )}
      <rect x="86" y="122" width="28" height="12" rx="4" fill="#2A2A2D" />
      <ellipse cx="100" cy="164" rx="42" ry="40" fill="url(#rs-c)" />
      <circle cx="100" cy="160" r="17" fill="#08080A" />
      <path d="M100 149l9.5 5.5v11L100 171l-9.5-5.500v-11Z" fill="#C6F432" />
      <rect x="40" y="146" width="16" height="38" rx="8" fill="url(#rs-c)" />
      <rect x="144" y="146" width="16" height="38" rx="8" fill="url(#rs-c)" />
      <circle cx="48" cy="190" r="10" fill="#2A2A2D" />
      <circle cx="152" cy="190" r="10" fill="#2A2A2D" />
    </svg>
  );
}

export function Robot3D({ mood = "idle", greet = true, className = "" }: { mood?: RobotMood; greet?: boolean; className?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const handle = useRef<RobotHandle | null>(null);
  const latest = useRef(mood);
  const [ready, setReady] = useState(false);
  latest.current = mood;

  useEffect(() => {
    if (!webglAvailable()) return;
    const motion = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let cancelled = false;
    import("../../lib/robot3d")
      .then(({ mountRobot }) => {
        if (cancelled || !canvas.current) return;
        handle.current = mountRobot(canvas.current, { motion, mood: latest.current, greet });
        setReady(true);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      handle.current?.stop();
      handle.current = null;
    };
  }, [greet]);

  useEffect(() => {
    handle.current?.setMood(mood);
  }, [mood]);

  return (
    <div className={`robot3d${ready ? " ready" : ""} ${className}`.trim()} aria-hidden="true">
      <RobotStill mood={mood} />
      <canvas ref={canvas} />
    </div>
  );
}
