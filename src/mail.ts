import nodemailer from 'nodemailer';
import { config } from './config.js';

export interface Mailer {
  sendOtp(to: string, code: string, ttlMinutes: number): Promise<void>;
}

function buildMessage(code: string, ttlMinutes: number) {
  const subject = `Your DairyFlow verification code: ${code}`;
  const text =
    `Your DairyFlow verification code is ${code}.\n\n` +
    `It expires in ${ttlMinutes} minutes. If you did not create a DairyFlow account, ignore this email.\n` +
    `Never share this code with anyone.`;
  const html =
    `<div style="font-family:Arial,sans-serif;max-width:420px">` +
    `<h2 style="color:#15803D">DairyFlow</h2>` +
    `<p>Your verification code is</p>` +
    `<p style="font-size:32px;letter-spacing:8px;font-weight:700">${code}</p>` +
    `<p>It expires in ${ttlMinutes} minutes. If you did not create a DairyFlow account, ignore this email.</p>` +
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
    async sendOtp(to, code, ttlMinutes) {
      await transport.sendMail({ from: config.SMTP_FROM, to, ...buildMessage(code, ttlMinutes) });
    },
  };
}

/** Development fallback: print the code instead of emailing it. Never used in production. */
const consoleMailer: Mailer = {
  async sendOtp(to, code) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Email delivery is not configured (set SMTP_HOST)');
    }
    console.log(`[DEV MAIL] OTP for ${to}: ${code}`);
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
