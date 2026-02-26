const baseUrl = process.env.BASE_URL || "http://127.0.0.1:3000";

async function api(path, options = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch (_err) {
    throw new Error(`Invalid JSON from ${path}: ${text.slice(0, 200)}`);
  }
  return { status: res.status, body };
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

function randomSuffix() {
  return `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
}

async function run() {
  const suffix = randomSuffix();
  const email = `smoke_${suffix}@example.com`;
  const displayName = `smoke${suffix.slice(-8)}`;
  const password = "SmokePass123";

  const health = await api("/api/health", { method: "GET", headers: {} });
  expect(health.status === 200 && health.body?.ok === true, "health check failed");

  const register = await api("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ email, displayName, password })
  });
  expect(register.status === 200 && register.body?.ok === true, "register failed");

  const verifyUrl = register.body?.verify_url;
  expect(typeof verifyUrl === "string" && verifyUrl.includes("verify="), "verify url missing");
  const token = verifyUrl.split("verify=")[1];

  const verify = await api("/api/auth/verify", {
    method: "POST",
    body: JSON.stringify({ token })
  });
  expect(verify.status === 200 && verify.body?.ok === true, "verify failed");

  const login = await api("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password, remember: true })
  });
  expect(login.status === 200 && login.body?.ok === true && login.body?.token, "login failed");

  const authHeader = { Authorization: `Bearer ${login.body.token}` };

  const submit = await api("/api/scores/submit", {
    method: "POST",
    headers: authHeader,
    body: JSON.stringify({ game: "tetris", value: 12345 })
  });
  expect(submit.status === 200 && submit.body?.ok === true, "score submit failed");

  const leaderboard = await api("/api/scores/leaderboard?game=tetris", {
    method: "GET",
    headers: authHeader
  });
  expect(leaderboard.status === 200 && Array.isArray(leaderboard.body?.rows), "leaderboard failed");

  console.log("Smoke test passed", {
    baseUrl,
    email,
    displayName,
    score: submit.body.best,
    rank: leaderboard.body?.me?.rank ?? null
  });
}

run().catch((err) => {
  console.error("Smoke test failed:", err.message);
  process.exit(1);
});
