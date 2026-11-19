export default function PayrollPage() {
  return (
    <section>
      <div className="kpis">
        <div className="kpi">
          <small>Payroll balance</small>
          <b className="num">–</b>
        </div>
        <div className="kpi">
          <small>Monthly cost</small>
          <b className="num">–</b>
        </div>
        <div className="kpi">
          <small>Covers</small>
          <b className="num">–</b>
        </div>
        <div className="kpi">
          <small>Next payment</small>
          <b className="num">–</b>
        </div>
      </div>
      <div className="panel">
        <h2>People you pay</h2>
        <p className="hint">Payments go only to these addresses, for these amounts, once per period.</p>
        <div className="lbwrap">
          <table className="lb">
            <thead>
              <tr>
                <th>Name</th>
                <th>Wallet</th>
                <th>Schedule</th>
                <th className="r">Amount</th>
                <th />
              </tr>
            </thead>
          </table>
        </div>
        <div className="lbempty-p">
          <p className="empty">Payroll arrives with live vaults.</p>
        </div>
        <div className="addrow pdisabled">
          <input type="text" placeholder="Name" aria-label="Name" disabled />
          <input type="number" placeholder="Amount in USDG" aria-label="Amount in USDG" disabled />
          <select aria-label="Schedule" disabled>
            <option>Monthly</option>
            <option>Every 2 weeks</option>
            <option>Weekly</option>
          </select>
          <button className="btn sm" disabled title="Payroll arrives with live vaults">
            Add person
          </button>
        </div>
      </div>
    </section>
  );
}
