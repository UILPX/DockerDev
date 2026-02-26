const crypto = require("crypto");
const Database = require("better-sqlite3");

const srcPath = process.env.REACTION_DB || "z:/docker/reaction/data/data.db";
const dstPath = process.env.GAMES_DB || "z:/docker/games/data/data.db";

const src = new Database(srcPath, { readonly: true });
const dst = new Database(dstPath);

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const digest = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${digest}`;
}

dst.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    verified INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS scores (
    user_id INTEGER NOT NULL,
    game TEXT NOT NULL,
    value INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(user_id, game)
  );
`);

const insertUser = dst.prepare(`
  INSERT OR IGNORE INTO users (email, display_name, password_hash, verified, created_at)
  VALUES (?, ?, ?, 1, ?)
`);
const getUser = dst.prepare("SELECT id FROM users WHERE display_name=?");
const upsertScore = dst.prepare(`
  INSERT INTO scores (user_id, game, value, updated_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(user_id, game) DO UPDATE SET
    value=excluded.value,
    updated_at=excluded.updated_at
`);

function ensureUser(name) {
  const safe = String(name).trim();
  if (!safe) return null;
  const email = `legacy+${safe.replace(/[^a-zA-Z0-9_-]/g, "_")}@local.invalid`;
  insertUser.run(email, safe, hashPassword(crypto.randomBytes(8).toString("hex")), Date.now());
  return getUser.get(safe)?.id || null;
}

const simple = src.prepare("SELECT name, best_ms FROM simple_scores").all();
const pro = src.prepare("SELECT name, best_ms FROM pro_scores").all();
const reactionMap = new Map();

for (const r of [...simple, ...pro]) {
  if (!r?.name || !Number.isInteger(r.best_ms)) continue;
  if (!reactionMap.has(r.name)) reactionMap.set(r.name, r.best_ms);
  else reactionMap.set(r.name, Math.min(reactionMap.get(r.name), r.best_ms));
}

let total = 0;
for (const [name, bestMs] of reactionMap.entries()) {
  const userId = ensureUser(name);
  if (!userId) continue;
  upsertScore.run(userId, "reaction", bestMs, Date.now());
  total++;
}

console.log(`migrated reaction score rows: ${total}`);
