# 1 VPS 部署

## 1.1 目标拓扑

生产环境复用现有 Docker、Nginx、Authentik、Tailscale 和 Cloudflare DNS。项目只占用回环端口 `13210`（API）、`13211`（Web）、`13212`（Worker 指标）和 `13213`（PostgreSQL）；Runner 的 `13214` 只存在于内部容器网络。

Nginx 只绑定 Tailscale IPv4，不在公网网卡监听。根路径直接进入控制台登录，所有页面、API、OpenAPI 和健康接口先受 Tailnet 限制；浏览器再经过 Authentik，Agent 使用作用域 API 密钥。

## 1.2 安全发布顺序

以下示例使用占位值。真实域名、服务器路径和凭据只在目标机的 root-only 环境中设置。

### 第一步：准备专用账户和目录

```bash
sudo bash deploy/scripts/prepare-vps.sh
```

该脚本不会清理 Docker，也不会修改其他项目的容器、网络、卷或 Nginx 站点。

### 第二步：生成生产密钥

```bash
sudo ROUTER_HOST=router.example.com bash deploy/scripts/prepare-production.sh
```

生成后的 `production.env` 默认包含 `JOB_SUBMISSION_ENABLED=false`。这意味着控制面可以上线，但在专用 Codex 登录和隔离探针完成前不会接收任务。

### 第三步：构建控制面

```bash
sudo RELEASE_DIR=/srv/example/model-router/releases/<commit> \
  PRODUCTION_ENV=/var/lib/aialra-model-router/production.env \
  bash deploy/scripts/install-compose-release.sh
```

脚本启动 PostgreSQL、API 和 Web，不启动 Worker。正式版本应优先使用 GHCR 返回的不可变镜像摘要，并先运行 `verify-production-images.sh`；VPS 源码构建只适合受控预发布。

### 第四步：创建 Cloudflare DNS

```bash
sudo CLOUDFLARE_API_TOKEN='<从密钥文件读取>' \
  CLOUDFLARE_ZONE_NAME=example.com \
  ROUTER_HOST=router.example.com \
  ROUTER_TAILSCALE_IPV6=fd7a:115c:a1e0::1 \
  bash deploy/scripts/upsert-cloudflare-dns.sh
```

Token 只需要目标 Zone 的 DNS Edit 和 Zone Read 权限。脚本只接受私有 Tailscale IPv6 地址，并创建 DNS-only AAAA 记录；没有 Tailnet 路由的设备即使能解析该地址也无法连接。它不会把 Router 接入 Cloudflare 公网代理。

### 第五步：签发证书

先用 Cloudflare DNS challenge 签发证书，再安装引用证书的 Nginx 配置。这样不会出现“配置引用尚不存在证书”的启动失败。

```bash
sudo certbot certonly --dns-cloudflare \
  --dns-cloudflare-credentials /root-only/cloudflare.ini \
  --dns-cloudflare-propagation-seconds 30 \
  --domain router.example.com \
  --non-interactive --agree-tos --email operator@example.com
```

Cloudflare SSL/TLS 模式必须为 Full (strict)。

### 第六步：登记 Authentik 应用

```bash
sudo AUTH_GATEWAY_APPS_FILE=/root-only/apps.json \
  AUTH_GATEWAY_SERVICE=example-auth-gateway.service \
  AUTH_GATEWAY_ENV_FILE=/root-only/aialra-auth-gateway.env \
  AUTHENTIK_SERVER_CONTAINER=authentik-server \
  ROUTER_HOST=router.example.com \
  bash deploy/scripts/register-auth-gateway-app.sh
```

脚本先备份共享应用清单，再把 `https://router.example.com/_aialra_auth/callback` 作为严格匹配的授权回调加入统一 Authentik OAuth Provider。若服务重启、健康状态或回调登记失败，它会恢复原文件并再次启动共享网关。仅更新应用清单而未登记回调时，Authentik 会返回 `Redirect URI Error`。

### 第七步：生成并启用 Nginx

```bash
sudo ROUTER_HOST=router.example.com \
  ROUTER_TAILSCALE_IPV4=100.64.0.10 \
  NGINX_TEMPLATE="$PWD/deploy/nginx/router.conf.template" \
  NGINX_OUTPUT=/etc/nginx/sites-available/router.example.com.conf \
  EDGE_PROOF_SNIPPET=/etc/nginx/snippets/router-edge-proof.conf \
  EDGE_PROXY_SECRET_FILE=/var/lib/aialra-model-router/secrets/edge_proxy_secret \
  AUTH_ENDPOINTS_SNIPPET=/etc/nginx/snippets/auth-endpoints.conf \
  AUTH_PROTECT_SNIPPET=/etc/nginx/snippets/auth-protect.conf \
  bash deploy/scripts/render-nginx.sh
sudo nginx -t
sudo systemctl reload nginx
```

`nginx -t` 失败时不得重载。部署者应保留旧站点文件，并在新入口冒烟失败时恢复旧文件。

Next.js 为页面生成每请求 nonce 和 Content Security Policy；Nginx 不再叠加第二份页面 CSP。

### 第八步：完成专用 Codex 登录

```bash
sudo -u aialra-router -H env CODEX_HOME=/var/lib/aialra-model-router/codex codex login --device-auth
sudo -u aialra-router -H env CODEX_HOME=/var/lib/aialra-model-router/codex codex login status
```

必须使用新的专用登录目录。不得复制或共享其他 Runner 正在使用的 `auth.json`。

随后运行恶意合成探针，证明 Runner 不能读取数据库密钥、正文主密钥、进程环境或 Codex 身份目录，不能联网或越过工作区，并且任务结束后没有残留会话文件。任何一项失败都保持接单关闭。

Codex 的 Linux 沙箱通过 `bubblewrap` 创建嵌套用户命名空间。Docker 默认 seccomp 会阻止所需的 `unshare(2)`；Ubuntu 24.04 还要求 AppArmor 明确允许非特权用户命名空间。启用 Worker 前先安装仓库内的专用配置：

```bash
sudo APPARMOR_PROFILE_SOURCE="$PWD/deploy/apparmor/aialra-codex-worker" \
  bash deploy/scripts/install-worker-apparmor.sh
```

Compose 仅对隔离 Runner 设置 `seccomp=unconfined` 和具名 `aialra-codex-worker` 配置。受信 Worker 只消费队列并调用 Runner，不挂载 Codex 身份目录，也不接触容器引擎套接字。外层仍保留 `cap_drop: ALL`、`no-new-privileges`、只读根文件系统、专用非 root 用户、内部控制网络和资源上限。

### 第九步：启用唯一 Worker

```bash
sudo RELEASE_DIR=/srv/example/model-router/releases/<commit> \
  PRODUCTION_ENV=/var/lib/aialra-model-router/production.env \
  CODEX_AUTH_DIR=/var/lib/aialra-model-router/codex \
  bash deploy/scripts/enable-codex-worker.sh
```

脚本先启动 `codex` profile 中的隔离 Runner 与唯一受信 Worker。两者健康检查和攻击探针通过后，才把接单开关改为 true 并重启 API。

## 1.3 上线验收

- 公网 IP 无法连接 Router 的 80 或 443 端口，Tailnet 内可以完成 TLS 握手。
- 根路径不提供公开展示面，直接进入 Authentik 登录。
- 未登录访问 `/console` 会进入 Authentik；正常登录后可以切页。
- 缺少 Router 专用 Authentik Group 或伪造 `X-Aialra-*` 头时均失败。
- 作用域 API 密钥可以读取模型并创建一个合成任务；吊销后立即失败。
- 实际 Luna 测试任务返回预期结果，额度快照不是固定 0。
- Nginx 下无 CSP 错误，控制台可以创建密钥和提交任务。
- 现有 Authentik 站点在变更前后都能正常登录。
- 重启后任务不丢失；24 小时后正文与事件已删除。

## 1.4 备份与回滚

`backup.sh` 从 PostgreSQL 容器流式导出并用 age 加密，不把数据库 URL 放进进程参数。加密产物仍需复制到独立故障域；只保存在同一 VPS 不算完整备份。

安装 `deploy/systemd/` 中的服务和定时器后，执行 `systemctl enable --now aialra-model-router-backup.timer`。服务以 root 运行是因为需要访问 Docker socket 和 root-only 收件人文件；它通过 `ProtectSystem=strict`、`NoNewPrivileges`、`PrivateTmp` 和仅允许写入备份目录限制文件访问。首次启用后必须手动启动一次服务，并检查生成的 `.dump.age` 文件非空。

回滚顺序：先关闭接单，排空 Worker，恢复上一镜像或上一 release，运行 `nginx -t`，再重载入口。数据库迁移持有 advisory lock 并记录版本；回滚不得删除已接任务。
