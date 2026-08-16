import { describe, expect, it } from "vitest";

import { parseSesFeedback } from "@/lib/email/feedback";

/**
 * The SES feedback parser, against Amazon's own documented payloads.
 *
 * The shapes below are the examples from the SES notification-contents and
 * event-publishing documentation, trimmed to the fields the parser reads and
 * with the addresses changed. Testing against them rather than against payloads
 * invented here is the same choice `sigv4.test.ts` makes about vectors: the
 * value of a parser test is entirely in whether the input is what the real
 * sender sends.
 *
 * What these tests are really guarding is `subtype`. Everything downstream of
 * this function turns on it — `record_email_feedback()` suppresses an address
 * permanently on `Permanent` and merely counts anything else — so a parser that
 * lowercased it, or that reached for `bounceSubType` because the name is more
 * specific, would turn every hard bounce into a soft one and quietly keep
 * mailing addresses that do not exist.
 */

const MAIL = {
  timestamp: "2026-08-16T09:58:38.237Z",
  messageId: "0100018b2c1e4d5f-1a2b3c4d-5e6f-7890-abcd-ef1234567890-000000",
  source: "no-reply@zevi.in",
  sourceArn: "arn:aws:ses:ap-south-1:123456789012:identity/zevi.in",
  sendingAccountId: "123456789012",
  destination: ["worker@example.com"],
};

describe("parseSesFeedback — bounces", () => {
  it("reads a permanent bounce, keeping bounceType as the subtype", () => {
    const events = parseSesFeedback({
      notificationType: "Bounce",
      bounce: {
        bounceType: "Permanent",
        bounceSubType: "General",
        bouncedRecipients: [
          {
            emailAddress: "worker@example.com",
            action: "failed",
            status: "5.1.1",
            diagnosticCode: "smtp; 550 5.1.1 user unknown",
          },
        ],
        timestamp: "2026-08-16T09:59:38.605Z",
        feedbackId: "0100018b2c1e4d5f-869464a4-8680-4114-98d3-716fe35851f9-000000",
        reportingMTA: "dsn; mta.example.com",
      },
      mail: MAIL,
    });

    expect(events).toEqual([
      {
        type: "bounce",
        providerMessageId: MAIL.messageId,
        recipient: "worker@example.com",
        // The value the suppression rule reads. Verbatim, not normalised.
        subtype: "Permanent",
        diagnostic: "General: smtp; 550 5.1.1 user unknown",
        occurredAt: "2026-08-16T09:59:38.605Z",
      },
    ]);
  });

  it("reads a transient bounce, which counts rather than suppresses", () => {
    const [event] = parseSesFeedback({
      notificationType: "Bounce",
      bounce: {
        bounceType: "Transient",
        bounceSubType: "MailboxFull",
        bouncedRecipients: [
          {
            emailAddress: "client@example.com",
            action: "failed",
            status: "4.2.2",
            diagnosticCode: "smtp; 452 4.2.2 Mailbox full",
          },
        ],
        timestamp: "2026-08-16T09:59:38.605Z",
      },
      mail: MAIL,
    });

    expect(event.subtype).toBe("Transient");
    expect(event.diagnostic).toBe("MailboxFull: smtp; 452 4.2.2 Mailbox full");
  });

  it("gives one event per bounced recipient", () => {
    const events = parseSesFeedback({
      notificationType: "Bounce",
      bounce: {
        bounceType: "Permanent",
        bounceSubType: "NoEmail",
        bouncedRecipients: [
          { emailAddress: "one@example.com", status: "5.1.1" },
          { emailAddress: "two@example.com", status: "5.1.1" },
        ],
        timestamp: "2026-08-16T09:59:38.605Z",
      },
      mail: MAIL,
    });

    // Both, and only the bounced ones — `mail.destination` may name recipients
    // whose copies were delivered perfectly well.
    expect(events.map((event) => event.recipient)).toEqual([
      "one@example.com",
      "two@example.com",
    ]);
  });

  it("falls back to Undetermined when SES does not say", () => {
    const [event] = parseSesFeedback({
      notificationType: "Bounce",
      bounce: {
        bouncedRecipients: [{ emailAddress: "worker@example.com" }],
        timestamp: "2026-08-16T09:59:38.605Z",
      },
      mail: MAIL,
    });

    // Not "Permanent". A missing bounceType must never be read as the value
    // that ends an address's ability to receive platform email.
    expect(event.subtype).toBe("Undetermined");
    expect(event.diagnostic).toBeNull();
  });

  it("falls back to the enhanced status code when there is no diagnostic", () => {
    const [event] = parseSesFeedback({
      notificationType: "Bounce",
      bounce: {
        bounceType: "Permanent",
        bouncedRecipients: [{ emailAddress: "worker@example.com", status: "5.1.1" }],
        timestamp: "2026-08-16T09:59:38.605Z",
      },
      mail: MAIL,
    });

    expect(event.diagnostic).toBe("5.1.1");
  });
});

describe("parseSesFeedback — complaints", () => {
  it("reads a complaint and its ARF feedback type", () => {
    const events = parseSesFeedback({
      notificationType: "Complaint",
      complaint: {
        complainedRecipients: [{ emailAddress: "client@example.com" }],
        timestamp: "2026-08-16T10:01:38.623Z",
        feedbackId: "0100018b2c1e4d5f-fea503bc-7497-49e1-881b-a0379bb037d3-000000",
        complaintFeedbackType: "abuse",
        userAgent: "AnyCompany Feedback Loop (V0.01)",
      },
      mail: MAIL,
    });

    expect(events).toEqual([
      {
        type: "complaint",
        providerMessageId: MAIL.messageId,
        recipient: "client@example.com",
        subtype: "abuse",
        diagnostic: "AnyCompany Feedback Loop (V0.01)",
        occurredAt: "2026-08-16T10:01:38.623Z",
      },
    ]);
  });

  it("reads a complaint that does not say what kind, which is most of them", () => {
    const [event] = parseSesFeedback({
      notificationType: "Complaint",
      complaint: {
        complainedRecipients: [{ emailAddress: "client@example.com" }],
        timestamp: "2026-08-16T10:01:38.623Z",
      },
      mail: MAIL,
    });

    // A null subtype must not stop it being a complaint: the suppression turns
    // on the event type, and a provider that reports one without a class has
    // still had a person press the button.
    expect(event.type).toBe("complaint");
    expect(event.subtype).toBeNull();
  });
});

describe("parseSesFeedback — the events that change nothing", () => {
  it("reads a delivery, whose recipients are bare strings", () => {
    const events = parseSesFeedback({
      notificationType: "Delivery",
      mail: MAIL,
      delivery: {
        timestamp: "2026-08-16T09:58:39.184Z",
        processingTimeMillis: 546,
        recipients: ["worker@example.com"],
        smtpResponse: "250 ok:  Message 64111812 accepted",
        reportingMTA: "a8-70.smtp-out.amazonses.com",
      },
    });

    expect(events).toEqual([
      {
        type: "delivery",
        providerMessageId: MAIL.messageId,
        recipient: "worker@example.com",
        subtype: null,
        diagnostic: "250 ok:  Message 64111812 accepted",
        occurredAt: "2026-08-16T09:58:39.184Z",
      },
    ]);
  });

  it("reads a delivery delay from the event-publishing shape", () => {
    const [event] = parseSesFeedback({
      eventType: "DeliveryDelay",
      mail: MAIL,
      deliveryDelay: {
        timestamp: "2026-08-16T10:15:40.641Z",
        delayType: "TransientCommunicationFailure",
        expirationTime: "2026-08-16T10:25:40.649Z",
        delayedRecipients: [
          {
            emailAddress: "worker@example.com",
            status: "4.4.1",
            diagnosticCode: "smtp; 421 4.4.1 Unable to connect to remote host",
          },
        ],
      },
    });

    expect(event.type).toBe("delivery_delay");
    expect(event.subtype).toBe("TransientCommunicationFailure");
  });

  it("reads a reject, whose recipients come from the mail envelope", () => {
    // A reject names none of its own: SES refused the message before any
    // recipient's server saw it.
    const events = parseSesFeedback({
      eventType: "Reject",
      mail: MAIL,
      reject: { reason: "Bad content" },
    });

    expect(events).toEqual([
      {
        type: "reject",
        providerMessageId: MAIL.messageId,
        recipient: "worker@example.com",
        subtype: null,
        diagnostic: "Bad content",
        occurredAt: MAIL.timestamp,
      },
    ]);
  });
});

describe("parseSesFeedback — both payload shapes", () => {
  it("reads eventType as well as notificationType", () => {
    const bounce = {
      bounceType: "Permanent",
      bounceSubType: "General",
      bouncedRecipients: [{ emailAddress: "worker@example.com", status: "5.1.1" }],
      timestamp: "2026-08-16T09:59:38.605Z",
    };

    // An identity notification and a configuration-set event carry the same
    // body under different discriminators. Reading only one of them looks like
    // "bounces are not arriving" rather than like a parser bug.
    expect(parseSesFeedback({ notificationType: "Bounce", bounce, mail: MAIL })).toEqual(
      parseSesFeedback({ eventType: "Bounce", bounce, mail: MAIL }),
    );
  });
});

describe("parseSesFeedback — what it declines to act on", () => {
  it("ignores the event types this platform does not handle", () => {
    for (const eventType of ["Send", "Open", "Click", "Rendering Failure", "Subscription"]) {
      expect(parseSesFeedback({ eventType, mail: MAIL })).toEqual([]);
    }
  });

  it("ignores a bounce with no message id to attach it to", () => {
    // Without one there is nothing to tie the event to something we sent, and
    // suppressing an address on the say-so of an unattributable payload is the
    // one outcome worth refusing outright.
    expect(
      parseSesFeedback({
        notificationType: "Bounce",
        bounce: {
          bounceType: "Permanent",
          bouncedRecipients: [{ emailAddress: "worker@example.com" }],
        },
        mail: { timestamp: MAIL.timestamp, destination: ["worker@example.com"] },
      }),
    ).toEqual([]);
  });

  it("ignores a bounce that names no recipients", () => {
    expect(
      parseSesFeedback({
        notificationType: "Bounce",
        bounce: { bounceType: "Permanent", bouncedRecipients: [] },
        mail: MAIL,
      }),
    ).toEqual([]);
  });

  it("ignores anything that is not an SES notification", () => {
    expect(parseSesFeedback(null)).toEqual([]);
    expect(parseSesFeedback("Bounce")).toEqual([]);
    expect(parseSesFeedback([])).toEqual([]);
    expect(parseSesFeedback({})).toEqual([]);
    expect(parseSesFeedback({ notificationType: "AmazonSnsSubscriptionSucceeded" })).toEqual([]);
  });
});
