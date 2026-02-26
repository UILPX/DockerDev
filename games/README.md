# Games Service

并行小游戏服务，和 `reaction` 独立部署，默认不影响 `reaction`。

## 功能
- 用户注册/登录/登出
- 支持会话记住用户（`remember=true` 约 30 天）
- 3 个小游戏：`2048`、`tetris`、`reaction`
- 各游戏排行榜 + 个人排名
- 邮箱验证注册（可接 SMTP）

## 启动
```powershell
cd z:\docker\games
docker compose up -d --build
```

## 邮件配置（可选）
在 `docker-compose.yaml` 里填：
- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_USER`
- `SMTP_PASS`
- `SMTP_FROM`

若不填，系统会把验证链接打印到日志里，方便先联调。

## iCloud 说明
- `iCloud+ 自定义邮箱域` 不是无限创建地址，通常受套餐和成员限制。
- 可以用你的域名邮箱对外发注册邮件，但要确保 DNS 里 `SPF/DKIM` 已按 Apple 指引配置。
- 建议用专门发信地址（例如 `noreply@你的域名`），避免用个人主邮箱直接发系统信。

## 可选迁移（后续再做）
默认不迁移 `reaction` 数据。

若要迁移可对齐的 `reaction` 成绩（simple/pro -> reaction）：
```powershell
cd z:\docker\games
node .\scripts\migrate-from-reaction.js
```
