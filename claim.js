// Cloudflare Pages Function: POST /api/claim
// Secrets/variables are set in the Cloudflare dashboard (never in this file):
//   FAUCETPAY_API_KEY  (secret)
//   TURNSTILE_SECRET   (secret)
//   CURRENCY           e.g. "DOGE"
//   REWARD_AMOUNT      smallest unit, e.g. "100000" (check FaucetPay docs for the unit per coin)
//   COOLDOWN_SECONDS   e.g. "3600" (KV minimum is 60)
//   DAILY_LIMIT        max payouts per day, e.g. "500"
// KV namespace binding: COOLDOWN

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, message: "Invalid request." }, 400);
  }

  const address = String(body.address || "").trim();
  const token = String(body.token || "");
  if (!address || address.length > 128) {
    return json({ ok: false, message: "Enter a valid FaucetPay address." }, 400);
  }
  if (!token) {
    return json({ ok: false, message: "Captcha missing." }, 400);
  }

  const ip = request.headers.get("CF-Connecting-IP") || "";

  // 1. Verify the Turnstile captcha
  const form = new FormData();
  form.append("secret", env.TURNSTILE_SECRET);
  form.append("response", token);
  form.append("remoteip", ip);
  const check = await fetch(
    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    { method: "POST", body: form }
  ).then((r) => r.json());
  if (!check.success) {
    return json({ ok: false, message: "Captcha failed. Try again." }, 400);
  }

  // 2. Cooldown per address and per IP
  const cooldown = Math.max(60, parseInt(env.COOLDOWN_SECONDS || "3600", 10));
  const addrKey = "addr:" + address.toLowerCase();
  const ipKey = "ip:" + ip;
  if ((await env.COOLDOWN.get(addrKey)) || (await env.COOLDOWN.get(ipKey))) {
    return json({ ok: false, message: "You already claimed recently. Come back later." }, 429);
  }

  // 3. Daily payout cap so a bug or attack can't drain your balance
  const day = new Date().toISOString().slice(0, 10);
  const capKey = "paid:" + day;
  const paidToday = parseInt((await env.COOLDOWN.get(capKey)) || "0", 10);
  if (paidToday >= parseInt(env.DAILY_LIMIT || "500", 10)) {
    return json({ ok: false, message: "Daily limit reached. Try again tomorrow." }, 503);
  }

  // Set cooldown before paying to reduce double-claims
  await env.COOLDOWN.put(addrKey, "1", { expirationTtl: cooldown });
  await env.COOLDOWN.put(ipKey, "1", { expirationTtl: cooldown });

  // 4. Pay through FaucetPay
  let result;
  try {
    const res = await fetch("https://faucetpay.io/api/v1/send", {
      method: "POST",
      body: new URLSearchParams({
        api_key: env.FAUCETPAY_API_KEY,
        to: address,
        amount: env.REWARD_AMOUNT,
        currency: env.CURRENCY,
        ip_address: ip,
      }),
    });
    result = await res.json();
  } catch {
    await env.COOLDOWN.delete(addrKey);
    await env.COOLDOWN.delete(ipKey);
    return json({ ok: false, message: "Payment service unreachable. Try again." }, 502);
  }

  if (result.status === 200) {
    await env.COOLDOWN.put(capKey, String(paidToday + 1), { expirationTtl: 172800 });
    return json({ ok: true, message: "Reward sent to your FaucetPay account!" });
  }

  // Failed payment: let the user retry
  await env.COOLDOWN.delete(addrKey);
  await env.COOLDOWN.delete(ipKey);
  return json({ ok: false, message: result.message || "Payment failed." }, 400);
}
