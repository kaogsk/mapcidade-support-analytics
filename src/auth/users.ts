// Named accounts, stored in the mirror DB. Page permissions are read from the store on
// every request (not from the token), so revoking access applies immediately.
import { randomBytes } from "node:crypto";
import { all, get, run, type Db } from "../db/db.js";
import { DUMMY_HASH, hashPassword, verifyPassword } from "./crypto.js";

/** Pages that need an explicit grant (admins always pass). */
export type Page = "cities" | "lowRatings";
/** Other support panels that trust this login. */
export type App = "queue" | "fieldDesk" | "statusBoard";
export const APPS: App[] = ["queue", "fieldDesk", "statusBoard"];

export interface User {
  username: string;
  name: string;
  admin: boolean;
  mustChangePassword: boolean;
  perms: Partial<Record<Page, boolean>>;
  apps: Partial<Record<App, boolean>>;
}

interface UserRow {
  username: string;
  name: string;
  password_hash: string;
  admin: number;
  must_change_password: number;
  perms: string;
  apps: string;
}

const toUser = (r: UserRow): User => ({
  username: r.username,
  name: r.name,
  admin: Boolean(r.admin),
  mustChangePassword: Boolean(r.must_change_password),
  perms: JSON.parse(r.perms || "{}"),
  apps: JSON.parse(r.apps || "{}"),
});

export class UsersStore {
  constructor(private readonly db: Db) {}

  private row(username: string): UserRow | undefined {
    return get<UserRow>(this.db, "SELECT * FROM users WHERE username = lower($u)", { u: String(username ?? "").trim() });
  }

  find(username: string | null | undefined): User | null {
    if (!username) return null;
    const r = this.row(username);
    return r ? toUser(r) : null;
  }

  list(): User[] {
    return all<UserRow>(this.db, "SELECT * FROM users ORDER BY username").map(toUser);
  }

  count(): number {
    return get<{ n: number }>(this.db, "SELECT count(*) AS n FROM users")?.n ?? 0;
  }

  create(u: { username: string; name: string; password: string; admin?: boolean; mustChangePassword?: boolean; perms?: User["perms"]; apps?: User["apps"] }, now: Date): User {
    run(
      this.db,
      `INSERT INTO users (username, name, password_hash, admin, must_change_password, perms, apps, created_at)
       VALUES (lower($username), $name, $hash, $admin, $mc, $perms, $apps, $now)`,
      {
        username: u.username.trim(),
        name: u.name,
        hash: hashPassword(u.password),
        admin: u.admin ? 1 : 0,
        mc: u.mustChangePassword ? 1 : 0,
        perms: JSON.stringify(u.perms ?? {}),
        apps: JSON.stringify(u.apps ?? {}),
        now: now.toISOString(),
      },
    );
    return this.find(u.username)!;
  }

  /** null when the credentials do not match. Same cost for unknown users. */
  verify(username: string, password: string): User | null {
    const r = this.row(username);
    const ok = verifyPassword(String(password ?? ""), r ? r.password_hash : DUMMY_HASH);
    return r && ok ? toUser(r) : null;
  }

  setPassword(username: string, password: string): void {
    run(this.db, "UPDATE users SET password_hash = $h, must_change_password = 0 WHERE username = lower($u)", { u: username, h: hashPassword(password) });
  }

  /** New temporary password (shown once); forces a change on next login. */
  resetPassword(username: string): string {
    const temp = randomBytes(6).toString("base64url");
    run(this.db, "UPDATE users SET password_hash = $h, must_change_password = 1 WHERE username = lower($u)", { u: username, h: hashPassword(temp) });
    return temp;
  }

  setPerm(username: string, page: Page, enabled: boolean): void {
    const u = this.find(username);
    if (!u) throw new Error("user not found");
    run(this.db, "UPDATE users SET perms = $p WHERE username = lower($u)", { u: username, p: JSON.stringify({ ...u.perms, [page]: enabled }) });
  }
}

export const canSee = (u: User | null, page: Page) => Boolean(u && (u.admin || u.perms[page]));
export const canUseApp = (u: User | null, app: App) => Boolean(u && (u.admin || u.apps[app]));

/** Demo accounts, created only on an empty store. */
export function seedDemoUsers(store: UsersStore, now: Date): { username: string; password: string }[] {
  if (store.count() > 0) return [];
  const demo = [
    { username: "manager", name: "Demo Manager", password: "demo-manager", admin: true },
    { username: "lead", name: "Demo Team Lead", password: "demo-lead", perms: { cities: true }, apps: { queue: true } },
    { username: "analyst", name: "Demo Analyst", password: "demo-analyst", apps: { queue: true } },
  ];
  for (const d of demo) store.create(d, now);
  return demo.map((d) => ({ username: d.username, password: d.password }));
}
