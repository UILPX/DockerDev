# DockerDev

一个包含多个 Node.js 服务的 Docker 化项目，面向 NAS/服务器生产部署场景。

## 项目组成

- `games/`：小游戏与账号系统服务（含登录、分数提交、榜单）。
- `reaction/`：反应测试服务（Simple / Pro / Aim 模式）。
- `main-site/`：主站静态/应用服务。
- `gallery/`：基于 NAS 目录自动建站的只读摄影作品展示服务。
- `nginx/`：反向代理配置。
- `deploy/`：生产部署入口（统一 compose 与更新脚本）。
- `docs/`：部署与风格规范文档。

## 运行方式（生产推荐）

1. 确认 Docker 网络 `webnet` 已创建（external network）。
2. 使用 `deploy/docker-compose.ghcr.yaml` 从 GHCR 拉取镜像并启动容器。
3. `games` 与 `reaction` 的 SQLite 数据库映射到宿主机文件，避免更新镜像导致数据丢失。
4. `gallery` 需要把 NAS 作品目录映射到容器 `/app/data/gallery`（建议只读挂载）。

## 自动构建发布

仓库包含 GitHub Actions 工作流：

- push 到 `main` 后自动检测变更服务；
- 仅构建并推送发生变更且包含 `Dockerfile` 的服务镜像；
- 推送到 `ghcr.io/<owner>/<service>`，平台为 `linux/amd64`。

## 许可证

本项目采用 [MIT License](./LICENSE)。
