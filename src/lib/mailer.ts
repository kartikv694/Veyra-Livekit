/**
 * Email sending for Veyra — meeting invites, the host's invite
 * confirmation, and password reset codes.
 *
 * Built on nodemailer rather than a hand-rolled SMTP client. An earlier
 * version of this file implemented the SMTP + STARTTLS handshake by hand
 * over raw sockets — that's exactly the kind of thing that's easy to get
 * subtly wrong (this project hit ERR_SSL_WRONG_VERSION_NUMBER from it:
 * a STARTTLS sequencing bug where the TLS handshake started before the
 * plaintext side was fully done, so the TLS layer read leftover plaintext
 * bytes as if they were a TLS record). nodemailer has handled this
 * correctly across every real-world SMTP server's quirks for years —
 * there's no good reason to keep maintaining a bespoke implementation of
 * a solved problem.
 */
import nodemailer, { type Transporter } from "nodemailer";

function env(name: string) {
  return process.env[name]?.trim() ?? "";
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// Created lazily and cached, not at module load time — a missing/bad env
// var only breaks the one request that actually tries to send an email,
// instead of crashing on import.
let cachedTransporter: Transporter | null = null;

function getTransporter(): Transporter {
  if (cachedTransporter) return cachedTransporter;

  const host = env("SMTP_HOST");
  const port = Number(env("SMTP_PORT") || "587");
  const user = env("SMTP_USER_EMAIL");
  const pass = env("SMTP_USER_PASSWORD");

  if (!host || !user || !pass) {
    throw new Error("SMTP is not configured. Set SMTP_HOST, SMTP_USER_EMAIL and SMTP_USER_PASSWORD.");
  }

  cachedTransporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465, // 465 = implicit TLS; 587 (the default here) = STARTTLS
    auth: { user, pass },
  });

  return cachedTransporter;
}

type MailOptions = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** Shown as the sender's display name — e.g. "Kartik Verma via Veyra".
   *  The actual sending address is always the authenticated SMTP
   *  account; Gmail (like virtually every provider) requires the From
   *  address to match whoever authenticated, to prevent spoofing, so
   *  this is the display name, not the address itself. */
  fromName?: string;
  /** If set, replies go here instead of the SMTP account — this is how
   *  an invite "from" a specific host actually reaches that host when
   *  someone hits Reply, without needing to send through their own
   *  address (which SMTP won't allow anyway). */
  replyTo?: string;
};

async function sendMail(options: MailOptions) {
  const transporter = getTransporter();
  const user = env("SMTP_USER_EMAIL");

  await transporter.sendMail({
    from: `"${options.fromName ?? "Veyra"}" <${user}>`,
    to: options.to,
    subject: options.subject,
    text: options.text,
    html: options.html,
    replyTo: options.replyTo,
  });
}

/**
 * Formats a scheduled time for display, using the host's timezone when
 * available, with a zone abbreviation (e.g. "GMT+5:30") appended so a
 * recipient elsewhere isn't misled into reading it as their own local
 * time. Deliberately never throws.
 *
 * Two formatter calls, not one: Intl.DateTimeFormat's `dateStyle`/
 * `timeStyle` shorthand options cannot be combined with the individual
 * component options — including `timeZoneName` — per spec; doing so
 * throws a TypeError unconditionally, regardless of which timezone
 * string is passed. (This was the actual cause of a previous version of
 * this function silently failing to send the scheduling email at all —
 * the throw happened before sendMail() ever ran, and looked like a bad
 * timezone string when it wasn't one.) So the styled date/time comes
 * from one formatter, and the abbreviation from a second, minimal one.
 */
function formatScheduledTime(scheduledAt: Date, timeZone?: string | null): string {
  if (timeZone) {
    try {
      const main = scheduledAt.toLocaleString(undefined, { dateStyle: "full", timeStyle: "short", timeZone });
      const parts = new Intl.DateTimeFormat(undefined, { timeZone, timeZoneName: "short", hour: "numeric" }).formatToParts(scheduledAt);
      const abbr = parts.find((p) => p.type === "timeZoneName")?.value;
      return abbr ? `${main} ${abbr}` : main;
    } catch (err) {
      console.error(`Invalid timezone "${timeZone}" formatting scheduled time — falling back:`, err);
    }
  }
  return scheduledAt.toLocaleString(undefined, { dateStyle: "full", timeStyle: "short" });
}

export async function sendMeetingInviteEmail(args: {
  to: string;
  hostName: string;
  hostEmail?: string;
  meetingUrl: string;
  scheduledAt?: Date | null;
  /** IANA zone (e.g. "Asia/Kolkata") the host was in when they picked
   *  scheduledAt — see the Meeting.timeZone schema comment. Without this,
   *  toLocaleString falls back to the server process's own default zone
   *  (UTC on Vercel), which silently renders the right instant as the
   *  wrong wall-clock time for everyone reading the email. */
  timeZone?: string | null;
  /** Optional display name for the meeting (e.g. "Weekly design sync") —
   *  see the Meeting.title schema comment. Falls back to the generic
   *  "a Veyra meeting" wording when not set. */
  title?: string | null;
}) {
  const when = args.scheduledAt ? formatScheduledTime(args.scheduledAt, args.timeZone) : "now";
  const meetingLabel = args.title ? `"${args.title}"` : "a Veyra meeting";

  const subject = args.scheduledAt ? `${args.hostName} scheduled ${meetingLabel}` : `${args.hostName} invited you to ${meetingLabel}`;
  const text = args.scheduledAt
    ? `${args.hostName} invited you to ${meetingLabel}, scheduled for ${when}.\n\nJoin the meeting: ${args.meetingUrl}`
    : `${args.hostName} invited you to ${meetingLabel}.\n\nJoin the meeting: ${args.meetingUrl}`;

  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.6;color:#202124">
      <h2>${escapeHtml(subject)}</h2>
      <p>${escapeHtml(args.hostName)} invited you to ${args.title ? `<strong>${escapeHtml(args.title)}</strong>` : "a Veyra meeting"}.</p>
      ${args.scheduledAt ? `<p><strong>Scheduled for:</strong> ${escapeHtml(when)}</p>` : ""}
      <p><a href="${escapeHtml(args.meetingUrl)}">${escapeHtml(args.meetingUrl)}</a></p>
      <p>Open the link to view the meeting and join when the host starts it.</p>
    </div>`;

  await sendMail({
    to: args.to,
    subject,
    text,
    html,
    fromName: `${args.hostName} via Veyra`,
    replyTo: args.hostEmail,
  });
}

export async function sendWelcomeEmail(args: { to: string; name: string }) {
  const subject = "Welcome to Veyra";
  const text = `Hi ${args.name},\n\nYour Veyra account is ready. Start a meeting and share the link, or join one with a code — no downloads required.\n\n— The Veyra team`;
  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.6;color:#202124">
      <h2>Welcome to Veyra, ${escapeHtml(args.name)}</h2>
      <p>Your account is ready. Start a meeting and share the link, or join one with a code — no downloads required.</p>
    </div>`;

  await sendMail({ to: args.to, subject, text, html });
}

export async function sendPasswordResetEmail(args: { to: string; code: string; validMinutes: number }) {
  const subject = "Your Veyra password reset code";
  const text = `Your Veyra password reset code is ${args.code}. It expires in ${args.validMinutes} minutes. If you didn't request this, you can safely ignore this email.`;
  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.6;color:#202124">
      <h2>Reset your password</h2>
      <p>Use the code below to reset your Veyra password. It expires in ${args.validMinutes} minutes.</p>
      <div style="font-size:32px;font-weight:700;letter-spacing:8px;background:#f1f5f9;padding:16px 24px;border-radius:10px;text-align:center;color:#0f172a">
        ${escapeHtml(args.code)}
      </div>
      <p style="color:#64748b;font-size:13px;margin-top:20px">
        If you didn't request this, you can safely ignore this email.
      </p>
    </div>`;

  await sendMail({ to: args.to, subject, text, html });
}
