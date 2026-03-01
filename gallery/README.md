# Gallery Service

Read-only gallery service driven by NAS folder structure.

## Goals

- Keep upload workflow simple for non-technical users (UGREEN Collection based).
- Keep website read-only for media files.
- Keep UI focused on photography content first.
- Keep long-term evolution predictable with stable conventions.

## Folder Layout

Mount your NAS root into `/app/data/gallery`:

```text
gallery-root/
  jeff/
    profile.json
    avatar.jpg
    1.jpg
    1.txt
    2.jpg
  alice/
    profile.json
    photos/
      day1.jpg
      day1.txt
```

Rules:
- each subfolder under root is one user.
- images are indexed recursively.
- photo sidecar caption uses same filename with `.txt`.
- optional `profile.json` provides display info.
- optional `bio.txt` is used when `profile.json` has no bio.
- visitors can leave per-photo comments (stored in `COMMENTS_FILE`).

## Product Roadmap

Planned upgrades are grouped by phase to keep development controlled.

### Phase 1 (Current Baseline)
- Folder-driven user discovery.
- Home slideshow/grid toggle + user slideshow/grid toggle.
- Bilingual UI by browser language.
- Per-photo visitor comments with anonymous option.

## Current Upload Flow

- Public uploads are collected by UGREEN Collection.
- Files are organized under `/volume1/docker/gallery/db/<username>/`.
- Deploy mapping mounts `/volume1/docker/gallery/db` to `/app/data/gallery` (read-only).
- Self-service edit/delete after upload is currently not supported.

## NAS Path Plan (Manual Create)

No path-related environment variables are used in this project.

Create these paths manually on NAS before deploy:

1. `/volume1/docker/gallery/db`
Purpose:
- media root, one folder per user (`<username>/...`)
- mounted to container `/app/data/gallery` as read-only

2. `/volume1/docker/gallery/state`
Purpose:
- runtime writable state (comments file)
- mounted to container `/app/data/state`

### Phase 2 (Stability + Moderation)
- Comment moderation tools (hide/delete/lock by admin).
- Basic abuse controls (rate limit, word filter, length policy).
- Optional read-only public mode and private mode switch.
- Better resilience for malformed user folders and media errors.

### Phase 3 (Metadata + Search)
- Support XMP/EXIF extraction for caption/date/camera metadata.
- Tag and keyword filtering.
- Time-based and photographer-based browsing shortcuts.
- Optional spotlight/featured curation list.

### Phase 4 (Content Workflow)
- Optional upload inbox folder and approval pipeline.
- Batch import report (new files, invalid files, skipped files).
- Template validator for `profile.json` and caption files.
- Visual admin dashboard for content health.

### Phase 5 (Distribution)
- CDN-friendly image variants and caching strategy.
- Optional watermark pipeline for public previews.
- Multi-arch container publish strategy (`amd64` + `arm64`).
- Backup/restore workflow for comments and state files.

## Development Standards

To keep future development stable, always follow:

- [SITE_STANDARDS.md](/Users/xp/Code/DockerDev/gallery/SITE_STANDARDS.md)
- [UPLOAD_SPEC.md](/Users/xp/Code/DockerDev/gallery/UPLOAD_SPEC.md)

This document defines:
- folder/data contract
- API contract
- UX and design rules
- change management checklist

## profile.json

```json
{
  "name": "Jeff",
  "bio": "Street and travel photographer.",
  "avatar": "avatar.jpg",
  "order": 10
}
```

## Local Run

```bash
cd /Users/xp/Code/DockerDev/gallery
docker compose -f docker-compose.local.yaml up -d --build
```

Then open `http://localhost:3000`.

## Mac Test (Recommended)

Use the local compose file to build native image on Apple Silicon:

```bash
cd /Users/xp/Code/DockerDev/gallery
docker compose -f docker-compose.local.yaml up -d --build
```

Stop:

```bash
docker compose -f docker-compose.local.yaml down
```

## Pre-Deploy Checklist

1. Confirm public help page copy is up to date (`/help.html`):
- upload link + QR code
- naming rules
- "edit before upload" policy

2. Confirm media mount path in deploy compose:
- host path contains user folders directly (`<username>/...`)
- mounted read-only to `/app/data/gallery`

3. Confirm state path is writable and persistent:
- comments file under `/app/data/state/comments.json`

4. Health-check inside running container:
```bash
docker compose -f docker-compose.local.yaml exec -T gallery \
  sh -lc 'wget -qO- http://127.0.0.1:3000/api/health'
```

## Runtime Defaults

- container media root: `/app/data/gallery`
- container state root: `/app/data/state`
- comment file: `/app/data/state/comments.json`
