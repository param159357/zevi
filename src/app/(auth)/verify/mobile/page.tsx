import type { Metadata } from "next";

import { AuthCard } from "@/components/auth/AuthCard";
import { MobileVerification } from "@/components/auth/MobileVerification";
import { SignOutButton } from "@/components/auth/SignOutButton";
import { requireStep } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Confirm your mobile · Zevi" };

export default async function VerifyMobilePage() {
  const context = await requireStep("verify_mobile");

  return (
    <AuthCard
      title="Confirm your mobile"
      description="Step 2 of 2. We send one code and never share your number with anyone you haven't worked with."
      footer={
        <div className="flex items-center justify-between gap-3">
          <span>Signed in as {context.profile.email}</span>
          <SignOutButton />
        </div>
      }
    >
      <MobileVerification defaultMobile={context.pendingMobile} />
    </AuthCard>
  );
}
