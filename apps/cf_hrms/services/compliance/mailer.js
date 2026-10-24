/**
 * mailer.js — sending one compliance email (spec §36.4). The same transport as the rest of the
 * backend (nodemailer over SMTP_URL — apps/karni_dashboard/services/alertService.js uses it the same
 * way; that app is not imported). The environment is read here and never printed.
 *
 * OFF unless SMTP_URL is set, and always off with CF_HRMS_COMPLIANCE_MAIL=off (a test sets it): the
 * outbox then keeps every email QUEUED, which is what a test checks — nothing is ever sent from one.
 */
export function mailConfigured() {
  if (String(process.env.CF_HRMS_COMPLIANCE_MAIL ?? '').toLowerCase() === 'off') return false;
  return Boolean(process.env.SMTP_URL);
}

let transport = null;
/** For a test: a fake transport ({ sendMail }) instead of SMTP. */
export function useTransport(t) { transport = t; }

export async function sendOne({ to, subject, html }) {
  if (!transport) {
    const { default: nodemailer } = await import('nodemailer');
    transport = nodemailer.createTransport(process.env.SMTP_URL);
  }
  await transport.sendMail({ from: process.env.COMPLIANCE_FROM || process.env.ALERT_FROM || 'CF HRMS <no-reply@cf-hrms>', to, subject, html });
}

export default { mailConfigured, sendOne, useTransport };
