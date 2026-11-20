/**
 * A small animated robot face for an agent. The look (head shape, eyes, antenna, accent colour) is worked out
 * from the agent's name or id, so the same agent always gets the same robot. The mood shows what the agent is
 * doing: watching the market, holding a position, or paused.
 */
import type { CSSProperties, ReactNode } from "react";

export type AvatarMood = "watch" | "hold" | "sleep";

const ACCENTS = ["#C6F432", "#8FE3B0", "#9AD8FF", "#FFC857", "#FF9E8A", "#C9B8FF"];
const SHELLS: [string, string][] = [
  ["#F1EEE6", "#B5B1A6"],
  ["#7C7C84", "#3E3E45"],
  ["#D9D5CA", "#98948A"],
  ["#6A7480", "#343A42"],
];

/** FNV-1a: a stable number from a string. */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function RobotAvatar({
  seed,
  size = 40,
  mood = "watch",
  house = false,
  tile = false,
  className = "",
}: {
  seed: string;
  size?: number;
  mood?: AvatarMood;
  /** Run by the Ratinole team: lime accent and a small crystal. */
  house?: boolean;
  /** Draw the robot on a rounded tile, like a profile picture. */
  tile?: boolean;
  className?: string;
}) {
  const h = hash(seed);
  const accent = house ? ACCENTS[0]! : ACCENTS[h % ACCENTS.length]!;
  const [shell, shade] = SHELLS[(h >>> 4) % SHELLS.length]!;
  const head = (h >>> 8) % 3; // rounded square, wide capsule, dome
  const eye = (h >>> 11) % 3; // pills, dots, bars
  const top = (h >>> 14) % 3; // ball antenna, twin antennas, crest
  const id = `rb${h.toString(36)}${size}`;
  const style = { "--rb": accent, "--rbd": `${-((h >>> 17) % 40) / 10}s`, width: size, height: size } as CSSProperties;

  const headShape =
    head === 0 ? (
      <rect x="9" y="17" width="46" height="37" rx="13" />
    ) : head === 1 ? (
      <rect x="7" y="20" width="50" height="33" rx="16.5" />
    ) : (
      <path d="M10 39C10 26 19.5 17 32 17s22 9 22 22v4c0 6-5 11-11 11H21c-6 0-11-5-11-11Z" />
    );

  return (
    <svg
      className={`rbot ${mood} ${className}`.trim()}
      style={style}
      viewBox="0 0 64 64"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id={`${id}s`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={shell} />
          <stop offset="1" stopColor={shade} />
        </linearGradient>
        <clipPath id={`${id}v`}>
          <rect x="15" y="26" width="34" height="19" rx="7.5" />
        </clipPath>
      </defs>
      {tile && (
        <>
          <rect x="1" y="1" width="62" height="62" rx="19" fill="rgba(255,255,255,.045)" />
          <rect x="1" y="1" width="62" height="62" rx="19" fill="var(--rb)" opacity=".1" />
          <rect x="1.5" y="1.5" width="61" height="61" rx="18.5" fill="none" stroke="var(--rb)" strokeOpacity=".38" />
        </>
      )}
      <g transform={tile ? "translate(8 9.5) scale(.75)" : undefined}>
      <g className="rb-bob">
        <g className="rb-ant">
          {top === 0 && (
            <>
              <path d="M32 17V9" stroke={shade} strokeWidth="2.4" strokeLinecap="round" />
              <circle className="rb-tip" cx="32" cy="7" r="3.4" />
            </>
          )}
          {top === 1 && (
            <>
              <path d="M24 18l-3-8M40 18l3-8" stroke={shade} strokeWidth="2.2" strokeLinecap="round" />
              <circle className="rb-tip" cx="20.6" cy="8.6" r="2.7" />
              <circle className="rb-tip" cx="43.4" cy="8.6" r="2.7" />
            </>
          )}
          {top === 2 && <path className="rb-tip" d="M26 17l6-9 6 9Z" />}
        </g>
        <rect x="4" y="30" width="6" height="12" rx="3" fill={shade} />
        <rect x="54" y="30" width="6" height="12" rx="3" fill={shade} />
        <g fill={`url(#${id}s)`} stroke="rgba(255,255,255,.28)" strokeWidth=".8">
          {headShape}
        </g>
        <rect x="15" y="26" width="34" height="19" rx="7.5" fill="#08080A" />
        <g clipPath={`url(#${id}v)`}>
          <path d="M13 24h14l-9 23H13Z" fill="#fff" opacity=".07" />
          <g className="rb-eyes">
           <g className="rb-lids">
            {mood === "sleep" ? (
              <path d="M21 36.5h7M36 36.5h7" stroke="var(--rb)" strokeWidth="2.6" strokeLinecap="round" opacity=".6" />
            ) : eye === 0 ? (
              <>
                <rect x="21.4" y="30.5" width="5.6" height="10" rx="2.8" />
                <rect x="37" y="30.5" width="5.6" height="10" rx="2.8" />
              </>
            ) : eye === 1 ? (
              <>
                <circle cx="24.2" cy="35.5" r="3.9" />
                <circle cx="39.8" cy="35.5" r="3.9" />
              </>
            ) : (
              <>
                <rect x="19.6" y="33" width="9.4" height="5" rx="2.5" />
                <rect x="35" y="33" width="9.4" height="5" rx="2.5" />
              </>
            )}
           </g>
          </g>
        </g>
        {house && <path d="M32 47.5l3.4 2-3.4 2-3.4-2Z" fill="var(--rb)" />}
      </g>
      </g>
    </svg>
  );
}

/** An empty-state line with the house robot beside it. */
export function BotNote({ children, mood = "watch" }: { children: ReactNode; mood?: AvatarMood }) {
  return (
    <div className="botnote">
      <RobotAvatar seed="ratinole" size={46} tile house mood={mood} />
      <p className="empty">{children}</p>
    </div>
  );
}
