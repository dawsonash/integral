// Transactional email via Resend's HTTP API (no SDK needed). Without an API
// key every send becomes a console line, so nothing upstream has to care
// whether email is configured. Fire-and-forget: a failed notification email
// must never fail the request that triggered it.
const FROM = process.env.EMAIL_FROM || 'Integral <onboarding@resend.dev>';

async function sendEmail({ to, subject, text }) {
  if (!to) return;
  if (!process.env.RESEND_API_KEY) {
    console.log(`[email skipped — no RESEND_API_KEY] to=${to} subject="${subject}"`);
    return;
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: FROM, to: [to], subject, text }),
    });
    if (!res.ok) console.error(`[email] send failed (${res.status}): ${await res.text()}`);
  } catch (e) {
    console.error('[email] send failed:', e.message);
  }
}

module.exports = { sendEmail };
