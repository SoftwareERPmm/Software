import { sql } from "@/lib/db";
import { currentUser } from "@/lib/session";
import { ROLES, ROLE_LABEL, ROLE_HINT } from "@/lib/auth";
import { NewUserForm, UserRow, type UserRecord } from "@/components/user-admin";

export const metadata = { title: "Users & roles · Myanmar ERP" };

export default async function UsersPage() {
  const me = await currentUser();
  const users = (await sql`
    select id, name, email, roles, is_active, must_change_password,
           to_char(last_login_at, 'YYYY-MM-DD"T"HH24:MI:SS') as last_login_at
      from app_user
     where password_hash is not null
     order by is_active desc, name`) as unknown as Omit<UserRecord, "is_me">[];

  const roles = ROLES.map((r) => ({ value: r, label: ROLE_LABEL[r], hint: ROLE_HINT[r] }));

  return (
    <>
      <div className="page-head">
        <span className="eyebrow">Master data</span>
        <h1>Users &amp; roles</h1>
        <p className="page-sub">
          Who can sign in, and what each person can reach. A person can hold
          several roles. Pages outside someone&rsquo;s roles are hidden from
          their menu and refused if they type the address.
        </p>
      </div>

      <NewUserForm roles={roles} />

      <section className="card">
        <div className="card-head"><h2>People</h2><span className="page-sub">{users.length}</span></div>
        <div className="tablewrap">
          <table>
            <thead><tr><th>Person</th><th>Roles</th><th>Last sign-in</th><th /></tr></thead>
            <tbody>
              {users.map((u) => (
                <UserRow key={u.id} user={{ ...u, is_me: u.id === me?.id }}
                         roles={roles} roleLabel={ROLE_LABEL} />
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
