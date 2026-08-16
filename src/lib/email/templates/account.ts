/**
 * The emails that are about the account rather than about a job.
 *
 * A third file next to `client.ts` and `worker.ts` because this one is neither.
 * A `profiles` row is one person whichever side of a job they are on, and an
 * email about their credentials reads the same to both — so `audience` is
 * `both`, there is no job reference in the subject, and nothing here loads a
 * job to compose itself.
 *
 * ### Why there is a security email at all
 *
 * Spec §15 lists essential events and this is not one of them, which is a real
 * argument against writing it and a weaker one than it looks. Every bullet on
 * that list is a receipt: something happened that the recipient was waiting to
 * hear about. This is the opposite shape — its whole value is in the case where
 * the person reading it did **not** do the thing it describes.
 *
 * A password reset needs the inbox and nothing else. That is the correct design
 * — it is what lets somebody who has forgotten everything back in — and it means
 * whoever holds the inbox holds the account. The only thing standing between a
 * quietly compromised mailbox and a quietly compromised Zevi account is the
 * owner noticing, and they cannot notice something nobody told them.
 */

import { defineTemplate } from "@/lib/email/template";

/**
 * Sent by `setNewPassword()`, after the password has actually changed.
 *
 * The action is the reset screen, not a support address, and that is the point
 * of the email rather than a detail of it: resetting again is the one move that
 * actually ends somebody else's access — it changes the password out from under
 * them and `scope: "others"` drops the session they are holding. Support is a
 * conversation that starts tomorrow. So the button is the thing that works in
 * the next thirty seconds, and the human is the footnote.
 *
 * No IP address and no device. Both are cheap to add — `clientIpAddress()`
 * already exists for signup — and neither is something a person can act on: a
 * mobile network's CGNAT address identifies a city on a good day, and "was this
 * you?" is a question the timestamp answers better than a number nobody
 * recognises. A line that looks like evidence and is not would make a real
 * compromise easier to dismiss, not harder.
 *
 * `whenLabel` is rendered in IST by the caller, because a security email that
 * makes somebody convert a timezone before they can tell whether it was them is
 * one they will put off reading.
 */
export const passwordChanged = defineTemplate({
  id: "password_changed",
  notification: "password_changed",
  audience: "both",
  fields: {
    whenLabel: "text",
    url: "url",
  },
  build: (p) => ({
    subject: "Your Zevi password was changed",
    preheader: `Changed ${p.whenLabel}. If that wasn't you, reset it again now.`,
    heading: "Your password was changed",
    blocks: [
      {
        kind: "paragraph",
        text: "The password on your Zevi account was changed, and anywhere else you were signed in has been signed out.",
      },
      {
        kind: "facts",
        rows: [{ label: "Changed", value: p.whenLabel, strong: true }],
      },
      {
        kind: "paragraph",
        text: "If that was you, there's nothing to do. If it wasn't, reset your password now — that locks out whoever set the current one and ends their session.",
      },
      {
        kind: "note",
        text: "We'll never email you asking for your password, a card number, or a one-time code.",
      },
    ],
    action: { label: "Reset your password", url: p.url },
    footnote: "If you can't get into your account, reply to this email and a person will help.",
  }),
});
