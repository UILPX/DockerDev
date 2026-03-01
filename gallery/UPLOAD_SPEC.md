# Upload Specification / 上传规范

This document defines what files the gallery currently accepts.
本文档定义当前画廊实际支持的上传文件类型与规则。

## 1) Supported Media Formats / 支持的媒体格式

- Image extensions / 图片后缀:
  - `.jpg`
  - `.jpeg`
  - `.png`
  - `.webp`
  - `.gif`
  - `.bmp`
  - `.avif`
  - `.heic`
  - `.heif`
- Video files are not indexed in current version.
  当前版本不索引视频文件。

## 2) Folder Contract / 目录约定

`GALLERY_ROOT` (default `/app/data/gallery`) should look like:

```text
gallery-root/
  jeff/
    profile.json
    avatar.jpg
    bio.txt
    1.jpg
    1.txt
    trips/
      2025-01.jpg
      2025-01.txt
  alice/
    profile.json
    cover.webp
```

- Each first-level subfolder is one photographer.
  根目录下每个一级子文件夹就是一个摄影师。
- Photographer slug = folder name (for example `jeff`).
  摄影师标识就是文件夹名（例如 `jeff`）。
- Images are scanned recursively.
  图片会递归扫描（支持子目录）。

Current production upload workflow:
当前线上上传流程：
- UGREEN Collection writes files into `/volume1/docker/gallery/db/<username>/`.
  绿联云收集会将文件写入 `/volume1/docker/gallery/db/<username>/`。
- Deploy should mount that path to `/app/data/gallery` in container.
  部署时应将该路径挂载到容器内 `/app/data/gallery`。
- Users should finish editing before upload. Post-upload self-service edit/delete is not supported.
  用户应在上传前完成修改。上传后暂不支持用户自助修改/删除。

## 3) Metadata Files / 元数据文件

### `profile.json` (optional / 可选)

- Must be strict JSON (no comments).
  必须是严格 JSON（不能带注释）。
- Supported fields:
  - `name` (string): display name / 展示名
  - `bio` (string): personal bio / 个人简介
  - `avatar` (string): relative image path / 头像相对路径
  - `order` (number): sort order (smaller first) / 排序值（越小越靠前）

Example:

```json
{
  "name": "Jeff",
  "bio": "Street and travel photographer.",
  "avatar": "avatar.jpg",
  "order": 10
}
```

### `bio.txt` (optional / 可选)

- Used only when `profile.json` has no valid `bio`.
  仅当 `profile.json` 中没有有效 `bio` 时生效。

### Per-photo caption sidecar `.txt` / 图片同名说明文件

- For photo `1.jpg`, caption file must be `1.txt` in same folder.
  对于 `1.jpg`，说明文件必须是同目录下的 `1.txt`。
- Max displayed caption length is 280 chars (longer text is truncated).
  显示长度上限为 280 字符（超出会截断）。

## 4) Filename Rules / 文件命名规则

- Chinese filenames are supported.
  支持中文文件名（例如 `海边日落.jpg`）。
- Caption sidecar must match photo basename exactly.
  说明文件必须与图片“主文件名”完全一致（仅后缀不同）。
- Do not use `/` or `\` in filenames.
  文件名不能包含 `/` 或 `\`。
- Avoid leading/trailing spaces in filenames.
  避免文件名前后空格。

## 5) Avatar Rules / 头像规则

- If `profile.avatar` points to an existing supported image, it is used.
  若 `profile.avatar` 指向存在且受支持的图片，则使用它。
- If missing, system auto-detects these filenames in user root:
  若未填写，会在用户根目录按以下文件名自动查找：
  - `avatar.jpg`, `avatar.jpeg`, `avatar.png`, `avatar.webp`, `avatar.avif`
  - `profile.jpg`, `profile.jpeg`, `profile.png`, `profile.webp`

## 6) Ignored Files / 忽略项

- Hidden files/folders (starting with `.`) are ignored.
  以 `.` 开头的隐藏文件/目录会被忽略。
- Directories named `@eaDir` and `.trash` are ignored.
  名为 `@eaDir` 和 `.trash` 的目录会被忽略。
- Non-image files are not indexed as gallery media.
  非图片文件不会被当作画廊媒体索引。

## 7) Refresh Behavior / 刷新生效机制

- Server rescans periodically via `SCAN_INTERVAL_MS` (default `120000` ms).
  服务端按 `SCAN_INTERVAL_MS` 周期扫描（默认 `120000` 毫秒）。
- You can also click `Refresh` in the UI for immediate update.
  也可以在页面点击 `Refresh` 触发即时刷新。

## 8) Common Errors / 常见错误

- `profile.json` contains comments or invalid JSON.
  `profile.json` 写了注释或 JSON 格式错误。
- Caption filename does not exactly match photo filename.
  说明文件名与图片名不完全一致。
- Filename contains invalid path characters like `/` or `\`.
  文件名包含了路径字符（如 `/` 或 `\`）。
- `avatar` path points to non-image file or missing file.
  `avatar` 路径不是图片，或文件不存在。
- Uploaded unsupported format (for example `.mp4`).
  上传了不受支持格式（例如 `.mp4`）。
