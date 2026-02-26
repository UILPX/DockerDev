# Docker 部署规范（生产统一标准）

本规范用于统一本仓库后续新增服务的 Docker 目录结构、Compose 配置、网络规则、数据落盘路径和 GitHub Actions 自动构建流程。

## 1. `deploy/` 目录是做什么的

`deploy/` 是面向生产/NAS（如绿联云）的一键部署入口：

- `deploy/docker-compose.ghcr.yaml`
  - 单文件编排，统一从 `ghcr.io` 拉取各服务镜像。
  - 适合图形化 Docker 界面直接导入。
- `deploy/.env.example`
  - 环境变量模板，复制为 `.env` 后按需调整镜像 tag、数据文件路径、可选业务变量。
- `deploy/scripts/update-prod.sh`
  - 生产更新脚本：拉最新镜像、重建容器、清理旧镜像、确保数据库文件存在。

## 2. 服务目录结构规范

新增服务（例如 `abc`）必须遵循：

```text
abc/
├─ Dockerfile
├─ docker-compose.yaml
├─ server.js (或应用入口)
├─ public/              # 可选，静态资源打包进镜像
└─ data/
   └─ data.db           # SQLite 数据文件（宿主机持久化）
```

### 数据路径约定

- 统一容器内路径：`/app/data/data.db`
- 统一服务目录内默认宿主机路径：`./data/data.db`
- 新服务 `abc` 默认映射应为：

```yaml
volumes:
  - ${ABC_DB_PATH:-./data/data.db}:/app/data/data.db
```

## 3. 网络规范

- 所有生产容器必须加入同一个外部网络：`webnet`。
- 每个服务添加与服务名一致的 alias。

示例：

```yaml
networks:
  webnet:
    aliases:
      - abc

networks:
  webnet:
    external: true
```

## 4. Compose 规范（每个服务）

- 使用 `image:`（生产）而非 `build:`。
- 使用 `pull_policy: always`，确保拉最新标签。
- 使用 `restart: unless-stopped`。
- 数据库只挂载 `data.db` 文件，避免把静态资源目录覆盖到容器中。

示例（`abc/docker-compose.yaml`）：

```yaml
services:
  abc:
    image: ghcr.io/uilpx/abc:${IMAGE_TAG:-latest}
    pull_policy: always
    container_name: abc
    restart: unless-stopped
    volumes:
      - ${ABC_DB_PATH:-./data/data.db}:/app/data/data.db
    networks:
      webnet:
        aliases:
          - abc

networks:
  webnet:
    external: true
```

## 5. GitHub Actions 自动编译规范

工作流 `.github/workflows/docker-image.yml` 已改为自动发现一级目录下的 `Dockerfile`：

- 自动扫描 `./<service>/Dockerfile`
- 自动生成构建矩阵
- 自动推送 `ghcr.io/<owner>/<service>:latest` + `:sha`

因此，新增 `abc` 时只要满足：

1. 新建 `abc/Dockerfile`
2. push 到 `main`

CI 会自动把 `abc` 也纳入构建并推送，无需再手改矩阵。

## 6. 新增服务 `abc` 的落地清单

1. 新建 `abc/Dockerfile`
2. 新建 `abc/docker-compose.yaml`（按上面模板）
3. 新建 `abc/data/data.db`（首次可空文件）
4. 在 `deploy/docker-compose.ghcr.yaml` 增加 `abc` 服务段
5. 在 `deploy/.env.example` 增加 `ABC_DB_PATH=./volumes/abc/data.db`
6. 生产环境创建宿主机文件并部署

## 7. 生产部署建议

- 首次部署前先创建 `webnet` 外部网络
- 优先使用固定 tag（比如 commit SHA）做回滚
- 定期执行 `docker image prune -af` 清理旧层
- 确认 GHCR 包可见性/权限（private 包需凭据）
