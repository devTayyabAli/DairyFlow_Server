import nodemailer from 'nodemailer';
import { config } from './config.js';

export interface Mailer {
  sendOtp(to: string, code: string, ttlMinutes: number, purpose?: 'register' | 'reset'): Promise<void>;
}

function buildMessage(code: string, ttlMinutes: number, purpose: 'register' | 'reset' = 'register') {
  const reset = purpose === 'reset';
  const label = reset ? 'password reset code' : 'verification code';
  const ignore = reset
    ? 'If you did not request a password reset, ignore this email; your password is unchanged.'
    : 'If you did not create a DairyFlow account, ignore this email.';
  const subject = `Your DairyFlow ${label}: ${code}`;
  const text =
    `Your DairyFlow ${label} is ${code}.\n\n` +
    `It expires in ${ttlMinutes} minutes. ${ignore}\n` +
    `Never share this code with anyone.`;
  const html =
    `<div style="font-family:Arial,sans-serif;max-width:420px">` +
    `<h2 style="color:#15803D">DairyFlow</h2>` +
    `<p>Your ${label} is</p>` +
    `<p style="font-size:32px;letter-spacing:8px;font-weight:700">${code}</p>` +
    `<p>It expires in ${ttlMinutes} minutes. ${ignore}</p>` +
    `<p style="color:#888">Never share this code with anyone.</p></div>`;
  return { subject, text, html };
}

function createSmtpMailer(): Mailer {
  const transport = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_SECURE,
    auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASS } : undefined,
  });
  return {
    async sendOtp(to, code, ttlMinutes, purpose) {
      await transport.sendMail({ from: config.SMTP_FROM, to, ...buildMessage(code, ttlMinutes, purpose) });
    },
  };
}

/** Development fallback: print the code instead of emailing it. Never used in production. */
const consoleMailer: Mailer = {
  async sendOtp(to, code, _ttl, purpose) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Email delivery is not configured (set SMTP_HOST)');
    }
    console.log(`[DEV MAIL] ${purpose === 'reset' ? 'Password reset OTP' : 'OTP'} for ${to}: ${code}`);
  },
};

let mailer: Mailer | null = null;

export function getMailer(): Mailer {
  if (!mailer) mailer = config.SMTP_HOST ? createSmtpMailer() : consoleMailer;
  return mailer;
}

/** Test hook / alternative providers. */
export function setMailer(next: Mailer | null): void {
  mailer = next;
}
