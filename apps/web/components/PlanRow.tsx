import type { PlanRowDTO } from "@rationale/config";

/** One dt/dd pair of the "How the agent understood it" list. */
export function PlanRow({ label, lines, missing }: { label: string; lines: string[]; missing?: boolean }) {
  return (
    <>
      <dt>{label}</dt>
      <dd className={missing ? "down" : undefined}>
        {lines.map((l, i) => (
          <span key={i}>
            {i > 0 && <br />}
            {l}
          </span>
        ))}
      </dd>
    </>
  );
}

export function PlanRows({ rows }: { rows: PlanRowDTO[] }) {
  return (
    <dl className="kv">
      {rows.map((r) => (
        <PlanRow key={r.label} label={r.label} lines={r.lines} missing={r.tone === "missing"} />
      ))}
    </dl>
  );
}
