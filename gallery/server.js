const path = require("path");
const fs = require("fs/promises");
const crypto = require("crypto");
const express = require("express");

const app = express();
app.use(express.json({ limit: "16kb" }));

const PORT = toPositiveInt(process.env.PORT, 3000);
const LIBRARY_ROOT = path.resolve(process.env.GALLERY_ROOT || "/app/data/gallery");
const SCAN_INTERVAL_MS = toPositiveInt(process.env.SCAN_INTERVAL_MS, 120000);
const COMMENTS_FILE = path.resolve(process.env.COMMENTS_FILE || "/app/data/state/comments.json");
const MAX_COMMENT_NAME_LENGTH = 40;
const MAX_COMMENT_MESSAGE_LENGTH = 500;
const MAX_COMMENTS_PER_PHOTO = 200;

const IMAGE_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".gif",
  ".bmp",
  ".avif",
  ".heic",
  ".heif"
]);

const SKIPPED_DIR_NAMES = new Set(["@eaDir", ".trash"]);
const AVATAR_CANDIDATES = [
  "avatar.jpg",
  "avatar.jpeg",
  "avatar.png",
  "avatar.webp",
  "avatar.avif",
  "profile.jpg",
  "profile.jpeg",
  "profile.png",
  "profile.webp"
];

const state = {
  lastScanAt: null,
  users: [],
  usersBySlug: new Map()
};

const commentState = {
  loaded: false,
  byPhoto: new Map(),
  writeQueue: Promise.resolve()
};

let scanInFlight = null;
let lastScanError = null;

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    root: LIBRARY_ROOT,
    commentsFile: COMMENTS_FILE,
    lastScanAt: state.lastScanAt,
    userCount: state.users.length,
    commentCount: getCommentCount(),
    scanError: lastScanError ? lastScanError.message : null
  });
});

app.get("/api/users", (_req, res) => {
  const users = state.users.map((user) => ({
    slug: user.slug,
    name: user.name,
    bio: user.bio,
    avatarUrl: user.avatarUrl,
    coverUrl: user.coverUrl,
    coverRelPath: user.coverRelPath,
    photoCount: user.photoCount
  }));

  res.json({
    ok: true,
    lastScanAt: state.lastScanAt,
    users
  });
});

app.get("/api/comments", async (req, res) => {
  const slug = cleanText(req.query.slug);
  const relPath = normalizeRelPath(req.query.relPath);

  if (!slug || !relPath) {
    return res.status(400).json({ ok: false, msg: "slug and relPath are required." });
  }

  const user = state.usersBySlug.get(slug);
  if (!user) {
    return res.status(404).json({ ok: false, msg: "User not found." });
  }
  if (!isIndexedPhoto(user, relPath)) {
    return res.status(404).json({ ok: false, msg: "Photo not found." });
  }

  try {
    await ensureCommentsLoaded();
    const comments = getCommentsByPhoto(slug, relPath);
    return res.json({ ok: true, comments });
  } catch (error) {
    console.error("[comments] read failed:", error.message);
    return res.status(500).json({ ok: false, msg: "Failed to load comments." });
  }
});

app.post("/api/comments", async (req, res) => {
  const slug = cleanText(req.body && req.body.slug);
  const relPath = normalizeRelPath(req.body && req.body.relPath);
  const anonymous = Boolean(req.body && req.body.anonymous);
  const rawName = cleanText(req.body && req.body.name);
  const rawMessage = cleanText(req.body && req.body.message);

  if (!slug || !relPath) {
    return res.status(400).json({ ok: false, msg: "slug and relPath are required." });
  }
  if (!rawMessage) {
    return res.status(400).json({ ok: false, msg: "Message is required." });
  }
  if (rawMessage.length > MAX_COMMENT_MESSAGE_LENGTH) {
    return res.status(400).json({ ok: false, msg: `Message is too long. Max ${MAX_COMMENT_MESSAGE_LENGTH} chars.` });
  }

  const user = state.usersBySlug.get(slug);
  if (!user) {
    return res.status(404).json({ ok: false, msg: "User not found." });
  }
  if (!isIndexedPhoto(user, relPath)) {
    return res.status(404).json({ ok: false, msg: "Photo not found." });
  }

  const displayName = anonymous
    ? "Anonymous"
    : truncateText(rawName || "Anonymous", MAX_COMMENT_NAME_LENGTH);

  const comment = {
    id: createCommentId(),
    slug,
    relPath,
    name: displayName,
    message: truncateText(rawMessage, MAX_COMMENT_MESSAGE_LENGTH),
    createdAt: new Date().toISOString()
  };

  try {
    await ensureCommentsLoaded();
    appendComment(comment);
    await queuePersistComments();
    return res.status(201).json({ ok: true, comment });
  } catch (error) {
    console.error("[comments] write failed:", error.message);
    return res.status(500).json({ ok: false, msg: "Failed to save comment." });
  }
});

app.get("/api/users/:slug", (req, res) => {
  const user = state.usersBySlug.get(req.params.slug);
  if (!user) {
    return res.status(404).json({ ok: false, msg: "User not found." });
  }

  return res.json({
    ok: true,
    lastScanAt: state.lastScanAt,
    user: {
      slug: user.slug,
      name: user.name,
      bio: user.bio,
      avatarUrl: user.avatarUrl,
      photoCount: user.photoCount,
      photos: user.photos
    }
  });
});

app.get("/media/:slug/*", (req, res) => {
  const user = state.usersBySlug.get(req.params.slug);
  if (!user) {
    return res.status(404).json({ ok: false, msg: "User not found." });
  }

  const relPath = decodeUrlWildcard(req.params[0]);
  if (!relPath) {
    return res.status(404).json({ ok: false, msg: "Invalid file path." });
  }

  const absolutePath = resolveInside(user.absoluteDir, relPath);
  if (!absolutePath) {
    return res.status(403).json({ ok: false, msg: "Forbidden file path." });
  }

  if (!user.allowedFiles.has(absolutePath)) {
    return res.status(404).json({ ok: false, msg: "File not indexed." });
  }

  res.setHeader("Content-Disposition", "inline");
  res.setHeader("Cache-Control", "public, max-age=120");
  return res.sendFile(absolutePath);
});

const publicDir = path.join(__dirname, "public");
app.use(express.static(publicDir));
app.get("/u/:slug", (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

app.listen(PORT, () => {
  console.log(`Gallery running on :${PORT}`);
  console.log(`Library root: ${LIBRARY_ROOT}`);
  console.log(`Comments file: ${COMMENTS_FILE}`);
  void ensureCommentsLoaded();
  void refreshCache();
  setInterval(() => {
    void refreshCache();
  }, SCAN_INTERVAL_MS).unref();
});

function toPositiveInt(rawValue, fallbackValue) {
  const parsed = Number.parseInt(rawValue, 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return fallbackValue;
}

async function refreshCache() {
  if (scanInFlight) return scanInFlight;

  scanInFlight = (async () => {
    try {
      const users = await scanUsers();
      state.users = users;
      state.usersBySlug = new Map(users.map((user) => [user.slug, user]));
      state.lastScanAt = new Date().toISOString();
      lastScanError = null;
      console.log(`[scan] users=${users.length} at ${state.lastScanAt}`);
    } catch (error) {
      lastScanError = error;
      console.error("[scan] failed:", error.message);
    } finally {
      scanInFlight = null;
    }
  })();

  return scanInFlight;
}

async function scanUsers() {
  let entries = [];
  try {
    entries = await fs.readdir(LIBRARY_ROOT, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const folders = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith("."))
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true, sensitivity: "base" }));

  const users = [];

  for (const folderName of folders) {
    const user = await scanUser(folderName);
    users.push(user);
  }

  users.sort((a, b) => {
    const orderA = Number.isFinite(a.order) ? a.order : Number.POSITIVE_INFINITY;
    const orderB = Number.isFinite(b.order) ? b.order : Number.POSITIVE_INFINITY;
    if (orderA !== orderB) return orderA - orderB;
    return a.name.localeCompare(b.name, "en", { numeric: true, sensitivity: "base" });
  });

  return users;
}

async function scanUser(folderName) {
  const absoluteDir = path.join(LIBRARY_ROOT, folderName);
  const slug = folderName;
  const profile = await readProfile(absoluteDir);

  const name = cleanText(profile.name) || folderName;
  const bio = cleanText(profile.bio) || (await readOptionalText(path.join(absoluteDir, "bio.txt"))) || "";
  const order = parseOptionalNumber(profile.order);

  const avatarRelPath = await resolveAvatarRelPath(absoluteDir, profile.avatar);
  const allImagePaths = await collectImagePaths(absoluteDir);

  const allowedFiles = new Set();
  const photos = [];

  for (const absoluteImagePath of allImagePaths) {
    const relPath = toPosixRelative(absoluteDir, absoluteImagePath);
    if (!relPath) continue;
    if (avatarRelPath && relPath === avatarRelPath) {
      allowedFiles.add(absoluteImagePath);
      continue;
    }

    const caption = await readCaptionFromSidecar(absoluteImagePath);
    const url = `/media/${encodeURIComponent(slug)}/${encodePathSegments(relPath)}`;
    photos.push({
      name: path.basename(absoluteImagePath),
      relPath,
      url,
      caption
    });
    allowedFiles.add(absoluteImagePath);
  }

  photos.sort((a, b) => a.relPath.localeCompare(b.relPath, "en", { numeric: true, sensitivity: "base" }));

  const avatarUrl = avatarRelPath
    ? `/media/${encodeURIComponent(slug)}/${encodePathSegments(avatarRelPath)}`
    : null;

  if (avatarRelPath) {
    const avatarAbs = resolveInside(absoluteDir, avatarRelPath);
    if (avatarAbs) allowedFiles.add(avatarAbs);
  }

  return {
    slug,
    name,
    bio,
    order,
    absoluteDir,
    avatarUrl,
    coverRelPath: photos[0] ? photos[0].relPath : null,
    coverUrl: photos[0] ? photos[0].url : null,
    photoCount: photos.length,
    photos,
    photoRelSet: new Set(photos.map((photo) => photo.relPath)),
    allowedFiles
  };
}

async function readProfile(userDir) {
  const filePath = path.join(userDir, "profile.json");
  let text;

  try {
    text = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return {};
    throw error;
  }

  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch (error) {
    console.error(`[scan] invalid profile.json for ${userDir}:`, error.message);
  }

  return {};
}

async function resolveAvatarRelPath(userDir, profileAvatarValue) {
  if (typeof profileAvatarValue === "string" && profileAvatarValue.trim()) {
    const requested = normalizeRelPath(profileAvatarValue);
    if (requested) {
      const requestedAbs = resolveInside(userDir, requested);
      if (requestedAbs && (await pathExists(requestedAbs))) {
        const ext = path.extname(requestedAbs).toLowerCase();
        if (IMAGE_EXTENSIONS.has(ext)) return requested;
      }
    }
  }

  for (const candidate of AVATAR_CANDIDATES) {
    const candidateAbs = path.join(userDir, candidate);
    if (await pathExists(candidateAbs)) return candidate;
  }

  return null;
}

async function collectImagePaths(baseDir) {
  const output = [];
  await walkDirectory(baseDir, output);
  return output;
}

async function walkDirectory(currentDir, output) {
  let entries = [];
  try {
    entries = await fs.readdir(currentDir, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === "ENOENT") return;
    throw error;
  }

  entries.sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true, sensitivity: "base" }));

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;

    const absolutePath = path.join(currentDir, entry.name);

    if (entry.isDirectory()) {
      if (SKIPPED_DIR_NAMES.has(entry.name)) continue;
      await walkDirectory(absolutePath, output);
      continue;
    }

    if (!entry.isFile()) continue;

    const extension = path.extname(entry.name).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(extension)) continue;
    output.push(absolutePath);
  }
}

async function readCaptionFromSidecar(imagePath) {
  const sidecarPath = imagePath.replace(/\.[^.]+$/, ".txt");
  return readOptionalText(sidecarPath);
}

async function readOptionalText(filePath) {
  let text;

  try {
    text = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }

  const normalized = cleanText(text);
  if (!normalized) return null;

  if (normalized.length > 280) {
    return `${normalized.slice(0, 277)}...`;
  }
  return normalized;
}

function cleanText(value) {
  if (typeof value !== "string") return "";
  return value.trim();
}

function toPosixRelative(baseDir, absolutePath) {
  const relative = path.relative(baseDir, absolutePath);
  if (!relative || relative.startsWith("..")) return null;
  return relative.split(path.sep).join("/");
}

function encodePathSegments(relPath) {
  return relPath
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function decodeUrlWildcard(rawPath) {
  if (!rawPath || typeof rawPath !== "string") return null;

  try {
    const decoded = rawPath
      .split("/")
      .filter(Boolean)
      .map((segment) => safeDecodeSegment(segment))
      .map((segment) => segment.trim())
      .filter(Boolean);

    if (!decoded.length) return null;

    for (const segment of decoded) {
      if (segment === "." || segment === "..") return null;
      if (segment.includes("\\")) return null;
      if (segment.includes("/")) return null;
    }

    return decoded.join("/");
  } catch (_error) {
    return null;
  }
}

function normalizeRelPath(rawPath) {
  if (!rawPath || typeof rawPath !== "string") return null;
  const cleaned = rawPath.replace(/\\/g, "/").trim();
  if (!cleaned) return null;

  const segments = cleaned.split("/").filter(Boolean);
  if (!segments.length) return null;
  if (segments.some((segment) => segment === "." || segment === "..")) return null;

  return segments.join("/");
}

function safeDecodeSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch (_error) {
    return segment;
  }
}

function parseOptionalNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function resolveInside(baseDir, relPath) {
  const resolved = path.resolve(baseDir, relPath);
  const basePrefix = baseDir.endsWith(path.sep) ? baseDir : `${baseDir}${path.sep}`;

  if (resolved === baseDir || resolved.startsWith(basePrefix)) {
    return resolved;
  }
  return null;
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (_error) {
    return false;
  }
}

function isIndexedPhoto(user, relPath) {
  if (!user || !relPath) return false;
  if (user.photoRelSet && user.photoRelSet.has(relPath)) return true;
  return Array.isArray(user.photos) && user.photos.some((photo) => photo.relPath === relPath);
}

function createCommentId() {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function truncateText(value, maxLen) {
  if (typeof value !== "string") return "";
  if (value.length <= maxLen) return value;
  return value.slice(0, maxLen);
}

function getCommentKey(slug, relPath) {
  return `${slug}::${relPath}`;
}

function getCommentCount() {
  let count = 0;
  for (const items of commentState.byPhoto.values()) {
    count += items.length;
  }
  return count;
}

function getCommentsByPhoto(slug, relPath) {
  const key = getCommentKey(slug, relPath);
  const list = commentState.byPhoto.get(key) || [];
  return list.map((item) => ({
    id: item.id,
    slug: item.slug,
    relPath: item.relPath,
    name: item.name,
    message: item.message,
    createdAt: item.createdAt
  }));
}

function appendComment(comment) {
  const key = getCommentKey(comment.slug, comment.relPath);
  const list = commentState.byPhoto.get(key) || [];
  list.push(comment);

  if (list.length > MAX_COMMENTS_PER_PHOTO) {
    list.splice(0, list.length - MAX_COMMENTS_PER_PHOTO);
  }

  commentState.byPhoto.set(key, list);
}

async function ensureCommentsLoaded() {
  if (commentState.loaded) return;

  let rawText = "";
  try {
    rawText = await fs.readFile(COMMENTS_FILE, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      commentState.byPhoto = new Map();
      commentState.loaded = true;
      return;
    }
    throw error;
  }

  try {
    const payload = JSON.parse(rawText);
    const input = payload && Array.isArray(payload.comments) ? payload.comments : [];
    const byPhoto = new Map();

    for (const row of input) {
      if (!row || typeof row !== "object") continue;
      const slug = cleanText(row.slug);
      const relPath = normalizeRelPath(row.relPath);
      const name = truncateText(cleanText(row.name) || "Anonymous", MAX_COMMENT_NAME_LENGTH);
      const message = truncateText(cleanText(row.message), MAX_COMMENT_MESSAGE_LENGTH);
      const createdAt = cleanText(row.createdAt) || new Date().toISOString();

      if (!slug || !relPath || !message) continue;

      const key = getCommentKey(slug, relPath);
      const items = byPhoto.get(key) || [];
      items.push({
        id: cleanText(row.id) || createCommentId(),
        slug,
        relPath,
        name,
        message,
        createdAt
      });
      byPhoto.set(key, items);
    }

    for (const [key, items] of byPhoto.entries()) {
      if (items.length > MAX_COMMENTS_PER_PHOTO) {
        byPhoto.set(key, items.slice(items.length - MAX_COMMENTS_PER_PHOTO));
      }
    }

    commentState.byPhoto = byPhoto;
    commentState.loaded = true;
  } catch (error) {
    console.error("[comments] invalid comments file:", error.message);
    commentState.byPhoto = new Map();
    commentState.loaded = true;
  }
}

function queuePersistComments() {
  commentState.writeQueue = commentState.writeQueue
    .catch(() => null)
    .then(() => persistComments());
  return commentState.writeQueue;
}

async function persistComments() {
  const comments = [];
  for (const list of commentState.byPhoto.values()) {
    for (const item of list) {
      comments.push({
        id: item.id,
        slug: item.slug,
        relPath: item.relPath,
        name: item.name,
        message: item.message,
        createdAt: item.createdAt
      });
    }
  }

  await fs.mkdir(path.dirname(COMMENTS_FILE), { recursive: true });
  await fs.writeFile(
    COMMENTS_FILE,
    `${JSON.stringify({ version: 1, comments }, null, 2)}\n`,
    "utf8"
  );
}
