# 代码优化审查总结

本次审查聚焦在 `main-site`、`reaction`、`games` 三个服务的可维护性、性能和安全性。以下是按优先级整理的优化空间。

## P0（建议优先处理）

1. **修复 `reaction` 中重复的建表 SQL（可维护性 + 启动开销）**  
   `reaction/server.js` 在文件前段已执行一次 `CREATE TABLE IF NOT EXISTS`，但在后段又重复执行了相同的 `identities` / `simple_scores` / `pro_scores` 建表语句。虽然 `IF NOT EXISTS` 不会造成逻辑错误，但会增加噪音和不必要的启动步骤，后续迭代也容易出现“只改了一处”的配置漂移。

2. **补充数据库索引（排行榜与排名查询性能）**  
   两个服务都大量使用按分数排序、按用户查排名的查询，随着数据增长会出现全表扫描：
   - `reaction`：`simple_scores` / `pro_scores` / `aim_scores` 的排行榜和 rank 计算。
   - `games`：`scores` 表按 `game` 过滤并按 `value + display_name` 排序。
   建议补充复合索引，如 `(best_ms, name)`、`(best_score, name)`、`(game, value)` 等。

3. **限制 JSON body 大小与基础限流（抗滥用）**  
   目前 `reaction` 与 `games` 使用 `express.json()` 的默认配置，没有显式 body 大小限制；公开接口（如提交成绩、注册、登录）也无基础限流。建议设置 `express.json({ limit: "100kb" })`，并加入 IP/账号维度的速率限制。

## P1（高价值改进）

1. **将数据库语句预编译为常量（减少重复 prepare）**  
   目前很多接口在每次请求中动态 `db.prepare(...).get()/run()`。`better-sqlite3` 的典型优化是将高频 SQL 在启动时 `prepare` 成常量并复用。

2. **抽离重复的“更新最佳成绩”逻辑**  
   `reaction` 中 Simple/Pro/Aim 三种模式的“查询当前最好成绩 -> 比较 -> 更新/返回”模式高度相似，可抽象成通用函数，降低维护成本。

3. **统一错误响应结构与日志字段**  
   不同接口的错误文案和错误码粒度不一致。建议定义统一错误码（如 `INVALID_INPUT`, `UNAUTHORIZED`, `RATE_LIMITED`）并附带 request id，便于前端提示和日志追踪。

4. **会话清理策略改进**  
   `games` 在读取 session 时仅被动清理单个过期 token。建议增加定时批量清理（或启动时清理），防止会话表长期膨胀。

## P2（中长期优化）

1. **容器镜像构建可再收敛**  
   - 建议统一使用 `npm ci --omit=dev`（有 lockfile 时）以提高可复现性。
   - 可引入非 root 用户运行 Node 进程，降低容器权限风险。

2. **Nginx 反向代理可补充超时与缓存策略**  
   目前配置主要是转发 header，缺少 `proxy_read_timeout`、静态资源缓存等策略。对高并发或弱网场景会更有帮助。

3. **增加自动化测试覆盖**  
   `games` 有 `smoke-test.js`，但整体 API 行为（输入边界、认证流程、排行榜排序）仍建议补齐可自动执行的集成测试，避免回归。

## 推荐执行顺序（落地路线）

1. 先做 `reaction` 重复 SQL 清理 + 两个服务的索引补齐。  
2. 再做 body 限制、限流和统一错误结构。  
3. 最后做代码抽象、测试补齐、容器与 Nginx 配置优化。

---

如果你愿意，我可以下一步直接给出一版“最小风险改造 PR”（先做索引 + 重复 SQL 清理 + JSON limit），改动小、收益大，也便于你快速上线验证。
# 代码优化审查总结

本次审查聚焦在 `main-site`、`reaction`、`games` 三个服务的可维护性、性能和安全性。以下是按优先级整理的优化空间。

## P0（建议优先处理）

1. **修复 `reaction` 中重复的建表 SQL（可维护性 + 启动开销）**  
   `reaction/server.js` 在文件前段已执行一次 `CREATE TABLE IF NOT EXISTS`，但在后段又重复执行了相同的 `identities` / `simple_scores` / `pro_scores` 建表语句。虽然 `IF NOT EXISTS` 不会造成逻辑错误，但会增加噪音和不必要的启动步骤，后续迭代也容易出现“只改了一处”的配置漂移。

2. **补充数据库索引（排行榜与排名查询性能）**  
   两个服务都大量使用按分数排序、按用户查排名的查询，随着数据增长会出现全表扫描：
   - `reaction`：`simple_scores` / `pro_scores` / `aim_scores` 的排行榜和 rank 计算。
   - `games`：`scores` 表按 `game` 过滤并按 `value + display_name` 排序。
   建议补充复合索引，如 `(best_ms, name)`、`(best_score, name)`、`(game, value)` 等。

3. **限制 JSON body 大小与基础限流（抗滥用）**  
   目前 `reaction` 与 `games` 使用 `express.json()` 的默认配置，没有显式 body 大小限制；公开接口（如提交成绩、注册、登录）也无基础限流。建议设置 `express.json({ limit: "100kb" })`，并加入 IP/账号维度的速率限制。

## P1（高价值改进）

1. **将数据库语句预编译为常量（减少重复 prepare）**  
   目前很多接口在每次请求中动态 `db.prepare(...).get()/run()`。`better-sqlite3` 的典型优化是将高频 SQL 在启动时 `prepare` 成常量并复用。

2. **抽离重复的“更新最佳成绩”逻辑**  
   `reaction` 中 Simple/Pro/Aim 三种模式的“查询当前最好成绩 -> 比较 -> 更新/返回”模式高度相似，可抽象成通用函数，降低维护成本。

3. **统一错误响应结构与日志字段**  
   不同接口的错误文案和错误码粒度不一致。建议定义统一错误码（如 `INVALID_INPUT`, `UNAUTHORIZED`, `RATE_LIMITED`）并附带 request id，便于前端提示和日志追踪。

4. **会话清理策略改进**  
   `games` 在读取 session 时仅被动清理单个过期 token。建议增加定时批量清理（或启动时清理），防止会话表长期膨胀。

## P2（中长期优化）

1. **容器镜像构建可再收敛**  
   - 建议统一使用 `npm ci --omit=dev`（有 lockfile 时）以提高可复现性。
   - 可引入非 root 用户运行 Node 进程，降低容器权限风险。

2. **Nginx 反向代理可补充超时与缓存策略**  
   目前配置主要是转发 header，缺少 `proxy_read_timeout`、静态资源缓存等策略。对高并发或弱网场景会更有帮助。

3. **增加自动化测试覆盖**  
   `games` 有 `smoke-test.js`，但整体 API 行为（输入边界、认证流程、排行榜排序）仍建议补齐可自动执行的集成测试，避免回归。

## 推荐执行顺序（落地路线）

1. 先做 `reaction` 重复 SQL 清理 + 两个服务的索引补齐。  
2. 再做 body 限制、限流和统一错误结构。  
3. 最后做代码抽象、测试补齐、容器与 Nginx 配置优化。

---

如果你愿意，我可以下一步直接给出一版“最小风险改造 PR”（先做索引 + 重复 SQL 清理 + JSON limit），改动小、收益大，也便于你快速上线验证。

# 代码优化审查总结

本次审查聚焦在 `main-site`、`reaction`、`games` 三个服务的可维护性、性能和安全性。以下是按优先级整理的优化空间。

## P0（建议优先处理）

1. **修复 `reaction` 中重复的建表 SQL（可维护性 + 启动开销）**  
   `reaction/server.js` 在文件前段已执行一次 `CREATE TABLE IF NOT EXISTS`，但在后段又重复执行了相同的 `identities` / `simple_scores` / `pro_scores` 建表语句。虽然 `IF NOT EXISTS` 不会造成逻辑错误，但会增加噪音和不必要的启动步骤，后续迭代也容易出现“只改了一处”的配置漂移。

2. **补充数据库索引（排行榜与排名查询性能）**  
   两个服务都大量使用按分数排序、按用户查排名的查询，随着数据增长会出现全表扫描：
   - `reaction`：`simple_scores` / `pro_scores` / `aim_scores` 的排行榜和 rank 计算。
   - `games`：`scores` 表按 `game` 过滤并按 `value + display_name` 排序。
   建议补充复合索引，如 `(best_ms, name)`、`(best_score, name)`、`(game, value)` 等。

3. **限制 JSON body 大小与基础限流（抗滥用）**  
   目前 `reaction` 与 `games` 使用 `express.json()` 的默认配置，没有显式 body 大小限制；公开接口（如提交成绩、注册、登录）也无基础限流。建议设置 `express.json({ limit: "100kb" })`，并加入 IP/账号维度的速率限制。

## P1（高价值改进）

1. **将数据库语句预编译为常量（减少重复 prepare）**  
   目前很多接口在每次请求中动态 `db.prepare(...).get()/run()`。`better-sqlite3` 的典型优化是将高频 SQL 在启动时 `prepare` 成常量并复用。

2. **抽离重复的“更新最佳成绩”逻辑**  
   `reaction` 中 Simple/Pro/Aim 三种模式的“查询当前最好成绩 -> 比较 -> 更新/返回”模式高度相似，可抽象成通用函数，降低维护成本。

3. **统一错误响应结构与日志字段**  
   不同接口的错误文案和错误码粒度不一致。建议定义统一错误码（如 `INVALID_INPUT`, `UNAUTHORIZED`, `RATE_LIMITED`）并附带 request id，便于前端提示和日志追踪。

4. **会话清理策略改进**  
   `games` 在读取 session 时仅被动清理单个过期 token。建议增加定时批量清理（或启动时清理），防止会话表长期膨胀。

## P2（中长期优化）

1. **容器镜像构建可再收敛**  
   - 建议统一使用 `npm ci --omit=dev`（有 lockfile 时）以提高可复现性。
   - 可引入非 root 用户运行 Node 进程，降低容器权限风险。

2. **Nginx 反向代理可补充超时与缓存策略**  
   目前配置主要是转发 header，缺少 `proxy_read_timeout`、静态资源缓存等策略。对高并发或弱网场景会更有帮助。

3. **增加自动化测试覆盖**  
   `games` 有 `smoke-test.js`，但整体 API 行为（输入边界、认证流程、排行榜排序）仍建议补齐可自动执行的集成测试，避免回归。

## 推荐执行顺序（落地路线）

1. 先做 `reaction` 重复 SQL 清理 + 两个服务的索引补齐。  
2. 再做 body 限制、限流和统一错误结构。  
3. 最后做代码抽象、测试补齐、容器与 Nginx 配置优化。

---

如果你愿意，我可以下一步直接给出一版“最小风险改造 PR”（先做索引 + 重复 SQL 清理 + JSON limit），改动小、收益大，也便于你快速上线验证。

## Deployment bundle for UGREEN Docker GUI

Added `deploy/docker-compose.ghcr.yaml` so a NAS GUI can import **one compose source** and pull all three service images (`games`, `reaction`, `main-site`) from GHCR in one shot.

Usage:
- Import `deploy/docker-compose.ghcr.yaml` directly in Docker GUI (no `.env` required).
- Create database files `./volumes/games/data.db` and `./volumes/reaction/data.db` before first run (relative to `deploy/`).
- Import `deploy/docker-compose.ghcr.yaml` in your Docker GUI (or run with `docker compose -f deploy/docker-compose.ghcr.yaml up -d`).

## Production-ready compose rewrite

All service compose files now use GHCR images directly with `pull_policy: always` and are attached to the external `webnet` network.

For one-shot NAS/server updates, run:

```bash
cd deploy
./scripts/update-prod.sh
```

The update script will:
- Pull latest images from GHCR
- Recreate containers with current tags
- Prune old/dangling images to reclaim space
- Ensure SQLite DB files exist at mapped host paths

## Docker deployment standard document

See `docs/DOCKER_DEPLOY_STANDARD.md` for unified rules on:
- deploy folder purpose,
- service directory/layout conventions,
- `webnet` network policy,
- DB file mapping convention (`<service>/data/data.db`),
- and how new services (e.g. `abc`) are auto-built by GitHub Actions.
