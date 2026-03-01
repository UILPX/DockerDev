# Gallery Site Standards

This document is the stable contract for future development of the gallery service.

## 1. Scope

- This project is a NAS-folder-driven photography showcase.
- Media files are read-only from app perspective.
- User and photo discovery come from filesystem scan, not DB models.
- Interactive state (comments, moderation metadata, future admin states) is stored under `/app/data/state`.

## 2. Data Contract

### 2.1 User Folder Model

Root path: `GALLERY_ROOT` (default `/app/data/gallery`).

Contract:
- each direct child folder = one photographer/user.
- hidden folders/files are ignored.
- images are indexed recursively.
- supported image extensions are controlled in `server.js`.

### 2.2 User Metadata Files

Supported files:
- `profile.json` (optional): `name`, `bio`, `avatar`, `order`.
- `bio.txt` (optional fallback when `profile.json.bio` missing).
- avatar files (`avatar.jpg/png/webp/...`) optional.

Rule:
- `profile.json` must be strict JSON (no comments/trailing commas).

### 2.3 Photo Caption Files

- Sidecar caption file must use the same basename as the image, with `.txt`.
- Example: `1.jpg` -> `1.txt`, `sunset.webp` -> `sunset.txt`.

### 2.4 Runtime State

- Comments file default: `/app/data/state/comments.json`.
- State files must be backward compatible when schema evolves.
- State schema updates must include migration logic or compatible fallback.

## 3. API Contract

Current public API:
- `GET /api/health`
- `GET /api/users`
- `GET /api/users/:slug`
- `GET /api/comments?slug=...&relPath=...`
- `POST /api/comments`
- `GET /media/:slug/*`

Rules:
- Keep response envelope shape stable (`ok`, payload fields).
- Add fields in backward-compatible way only.
- Do not rename/remove existing fields without migration versioning.
- Validate all user input on write endpoints.

## 4. Security & Abuse Controls

- Prevent path traversal on all media and relPath handling.
- Keep media served as indexed allowlist only.
- Limit comment name/message length in backend.
- Add rate limiting before opening to broad public traffic.
- Never trust frontend validation alone.

## 5. UI/UX Standards

### 5.1 Visual Priority

- Primary focus must remain on photos, not text blocks.
- Avoid large explanatory text on core gallery screens.
- Keep controls minimal and secondary.

### 5.2 Layout Rules

- Homepage: single-button toggle between slideshow and photographer grid.
- User page: single-button toggle between slideshow and photo grid.
- Grid mode should hide per-photo discussion panel where no single current photo exists.
- Discussion panel: compact, collapsible if feature set grows.
- Mobile: swipe navigation remains first-class behavior.

### 5.3 Language Rules

- UI supports bilingual output by browser language (`zh*` => Chinese, else English).
- New user-facing copy must include both languages.
- Template/help content must keep bilingual clarity.

## 6. Comment System Rules

- Comments are per-photo, keyed by `(slug, relPath)`.
- Anonymous comments are allowed.
- Keep ordering deterministic (append order by `createdAt`/insert order).
- Preserve comments across container restarts via mounted state volume.

Future moderation requirements:
- admin delete/hide
- lock per photo
- lightweight audit fields (`createdAt`, optional `updatedAt`, moderation metadata)

## 7. Docker & Deployment Standards

- `gallery` service must mount:
  - read-only media root to `/app/data/gallery`
  - writable state root to `/app/data/state`
- Local and production compose files must use equivalent env var semantics.
- Deployment scripts must create required state directories before compose up.

## 8. Testing & Change Checklist

Before merging any feature:

1. API compatibility:
- Existing endpoints still return expected fields.

2. Filesystem behavior:
- New user folder appears without restart.
- New image appears after scan interval/refresh.

3. Comment behavior:
- comment create/read works for uppercase/lowercase filenames as stored.
- comments persist after container restart.

4. UX behavior:
- slideshow navigation (buttons + swipe) still works.
- bilingual copy is complete and not mixed.

5. Deployment:
- `docker compose ... config` passes for local/service/deploy compose files.

## 9. Versioning Guidance

- Treat this document as normative.
- Breaking changes require:
  - a migration note in `README.md`
  - compatibility strategy for existing folders/state files
  - explicit rollout steps for production operators
