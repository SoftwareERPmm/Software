import Link from "next/link";
import { redirect } from "next/navigation";
import { sql } from "@/lib/db";
import { currentUser } from "@/lib/session";
import { AuthFrame } from "@/components/auth-frame";
import { SignInForm, FirstAdminForm } from "@/components/auth-forms";

export const metadata = { title: "Sign in · Myanmar ERP" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  if (await currentUser()) redirect("/");
  const { next } = await searchParams;

  const [company] = await sql`select id from company order by created_at limit 1`;
  if (!company) {
    return (
      <AuthFrame title="Nothing set up yet" lead="Create the company first. Signing in comes after.">
        <Link href="/setup" className="auth-submit as-link">Set up the company</Link>
      </AuthFrame>
    );
  }

  // Nobody can sign in yet: the first person here becomes the administrator,
  // and this screen disappears for good once they have.
  const [{ n }] = await sql`select count(*)::int as n from app_user where password_hash is not null`;
  if (n === 0) {
    return (
      <AuthFrame
        title="Create the administrator"
        lead="Nobody can sign in yet. The account you create here can add everyone else and choose what they can reach."
      >
        <FirstAdminForm />
      </AuthFrame>
    );
  }

  return (
    <AuthFrame title="Sign in">
      <SignInForm next={next ?? "/"} />
    </AuthFrame>
  );
}
