"use client";

import { useEffect, useState, type FormEvent } from "react";

interface User { username: string; name: string; admin: boolean }
interface Kpis { total: number; concluded: number; pct_resp_sla: number | null; pct_sla: number | null; pct_reopen: number | null }
interface Ranking { analyst: string; team: string; total: number; concluded: number; pct_sla: number | null; pct_reopen: number | null }
interface Summary {
  kpis: Kpis;
  kpisExit: Kpis;
  backlog: { total: number };
  ranking?: Ranking[];
  timeline: { day: string; created: number; concluded: number }[];
}

async function api<T>(path: string, body?: object): Promise<T> {
  const response = await fetch(`/api/${path}`, body === undefined ? {} : {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error((await response.json()).error);
  return response.status === 204 ? undefined as T : response.json();
}

const percent = (n: number | null) => n === null ? "—" : `${n}%`;

export default function Dashboard() {
  const [user, setUser] = useState<User>();
  const [teams, setTeams] = useState<string[]>([]);
  const [team, setTeam] = useState("");
  const [days, setDays] = useState("30");
  const [analyst, setAnalyst] = useState("");
  const [summary, setSummary] = useState<Summary>();
  const [status, setStatus] = useState("");
  const [pending, setPending] = useState(false);
  const [revision, setRevision] = useState(0);

  useEffect(() => { api<User>("session").then(setUser).catch(() => {}); }, []);
  useEffect(() => {
    if (!user) return;
    api<string[]>("teams").then(setTeams).catch((error: Error) => setStatus(error.message));
  }, [user]);
  useEffect(() => {
    if (!user) return;
    let active = true;
    const path = analyst ? `analyst/${encodeURIComponent(analyst)}` : "overview";
    const q = new URLSearchParams({ team, days });
    api<Summary>(`${path}?${q}`).then((value) => {
      if (active) setSummary(value);
    }).catch((error: Error) => {
      if (active) setStatus(error.message);
    });
    return () => { active = false; };
  }, [user, team, days, analyst, revision]);

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    try {
      const data = Object.fromEntries(new FormData(event.currentTarget));
      setUser(await api<User>("login", data));
      setStatus("");
    } catch (error) {
      setStatus((error as Error).message);
    } finally {
      setPending(false);
    }
  }

  async function signOut() {
    try {
      await api("logout", {});
      setUser(undefined);
      setSummary(undefined);
      setAnalyst("");
      setStatus("");
    } catch (error) {
      setStatus((error as Error).message);
    }
  }

  async function run(kind: string) {
    setPending(true);
    setStatus("Synchronizing...");
    try {
      const result = await api<{ text?: string }>("sync", { kind });
      setStatus(result.text ?? "Mirror updated.");
      setRevision((n) => n + 1);
    } catch (error) {
      setStatus((error as Error).message);
    } finally {
      setPending(false);
    }
  }

  if (!user) return <main>
    <h1>Support analytics</h1>
    <p>Demo accounts include manager / demo-manager and analyst / demo-analyst.</p>
    <form onSubmit={signIn}>
      <label>Username<input name="username" autoComplete="username" required /></label>
      <label>Password<input name="password" type="password" autoComplete="current-password" required /></label>
      <button disabled={pending}>Sign in</button>
    </form>
    <p role="status">{status}</p>
  </main>;

  return <main>
    <header>
      <h1>Support analytics</h1>
      <div>{user.name} <button onClick={signOut}>Sign out</button></div>
    </header>
    <div className="toolbar">
      <label>Period<select value={days} onChange={(event) => setDays(event.target.value)}>
        <option value="7">7 days</option><option value="30">30 days</option><option value="90">90 days</option>
      </select></label>
      <label>Team<select value={team} onChange={(event) => setTeam(event.target.value)}>
        <option value="">Support overview</option>
        {teams.map((name) => <option key={name}>{name}</option>)}
      </select></label>
      <button onClick={() => setRevision((n) => n + 1)}>Refresh view</button>
      {user.admin && <>
        <button disabled={pending} onClick={() => run("incremental")}>Sync changes</button>
        <button disabled={pending} onClick={() => run("reconcile")}>Audit mirror</button>
      </>}
    </div>
    {status && <pre role="status">{status}</pre>}
    {analyst && <h2>{analyst} <button onClick={() => setAnalyst("")}>Overview</button></h2>}
    {summary && <>
      <dl className="tiles">
        <div><dt>Received</dt><dd>{summary.kpis.total}</dd></div>
        <div><dt>Concluded</dt><dd>{summary.kpisExit.concluded}</dd></div>
        <div><dt>Backlog now</dt><dd>{summary.backlog.total}</dd></div>
        <div><dt>First-response SLA</dt><dd>{percent(summary.kpis.pct_resp_sla)}</dd></div>
        <div><dt>Resolution SLA</dt><dd>{percent(summary.kpisExit.pct_sla)}</dd></div>
      </dl>
      {summary.ranking && <section>
        <h2>Analyst performance</h2>
        <div className="table"><table>
          <thead><tr><th>Analyst</th><th>Team</th><th>Received</th><th>Concluded</th><th>SLA</th><th>Reopened</th></tr></thead>
          <tbody>{summary.ranking.map((row) => <tr key={`${row.analyst}/${row.team}`}>
            <td><button onClick={() => setAnalyst(row.analyst)}>{row.analyst}</button></td><td>{row.team}</td>
            <td>{row.total}</td><td>{row.concluded}</td><td>{percent(row.pct_sla)}</td><td>{percent(row.pct_reopen)}</td>
          </tr>)}</tbody>
        </table></div>
      </section>}
      <section>
        <h2>Daily ticket flow</h2>
        <div className="table"><table>
          <thead><tr><th>Day</th><th>Received</th><th>Concluded</th></tr></thead>
          <tbody>{[...summary.timeline].reverse().map((row) => <tr key={row.day}>
            <td>{row.day}</td><td>{row.created}</td><td>{row.concluded}</td>
          </tr>)}</tbody>
        </table></div>
      </section>
    </>}
  </main>;
}
