import { redirect } from "next/navigation";
import { currentUser } from "@/lib/session";
import { AuthFrame } from "@/components/auth-frame";
import { ChangePasswordForm } from "@/components/auth-forms";

export const metadata = { title: "Change password · Myanmar ERP" };

export default async function PasswordPage() {
  const me = await currentUser();
  if (!me) redirect("/login");
  return (
    <AuthFrame
      title={me.mustChangePassword ? "Choose your password" : "Change password"}
      lead={me.mustChangePassword
        ? `Welcome, ${me.name}. The password you were given was for this first sign-in only.`
        : "Other devices signed in as you will be signed out."}
    >
      <ChangePasswordForm forced={me.mustChangePassword} />
    </AuthFrame>
  );
}
