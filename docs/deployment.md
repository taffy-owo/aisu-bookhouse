# 自部署

依赖安装和开发环境启动见 [本地运行](../README.md#本地运行)。以下为服务器部署配置。

## 生产配置

后端使用自己的环境文件或进程管理器注入以下配置：

| 配置 | 要求 |
| --- | --- |
| AISU_ENV | production |
| AISU_JWT_SECRET | 自己生成的至少 32 字符随机密钥 |
| AISU_ENCRYPTION_KEY | 另一个独立的至少 32 字符随机密钥 |
| AISU_DEFAULT_ADMIN_EMAIL / AISU_DEFAULT_ADMIN_PASSWORD | 自己的管理员邮箱与强密码，密码至少 12 字符 |
| AISU_CORS_ORIGINS | 明确填写自己的 HTTPS 来源，例如 https://books.example.com |
| AISU_DATABASE_URL | 指向持久化数据盘的 SQLite 文件，或自己的 PostgreSQL |
| AISU_STORAGE_ROOT | 持久化图书与任务目录 |
| AISU_AUTO_CREATE_TABLES | false，部署时使用 Alembic 迁移 |
| AISU_SEED_DEMO_DATA | false |
| AISU_BOOTSTRAP_ADMIN | 首次启动创建管理员时设为 true |
| AISU_UPLOAD_PROCESSING_MODE | external |
| AISU_AI_TRANSLATION_GLOBAL_DAILY_CALL_BUDGET | 正整数请求上限，例如 1000；生产配置校验要求此值 |

数据库、上传与备份目录不要放在前端静态目录中。生产校验会拒绝默认密码、默认密钥、不明确的 CORS 和自动建表等配置。

## 服务与 worker

在 backend 目录中，先为当前终端加载后端环境变量，再执行迁移：

```bash
set -a
. ./.env
set +a
python -m alembic upgrade head
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

worker 处理上传、整书翻译和定时检查来源更新。使用 systemd、容器编排或其他进程管理器分别运行 API 与 worker。两者应使用相同的数据库和存储配置；相对路径以进程工作目录为基准。

手动启动时，另开终端、激活后端虚拟环境，在 `backend` 目录加载 `.env` 后运行：

```bash
set -a
. ./.env
set +a
python -m app.modules.uploads.worker
```

首次部署前创建数据目录，并赋予服务用户读写权限。升级前备份数据库和存储目录，再执行迁移。

## 静态站点

构建时将前端 API 地址设为同源路径：

```bash
VITE_API_BASE_URL=/api/v1 npm run build
```

由 Nginx、Caddy 等服务托管 dist；/api/ 反向代理到 API，前端路由回退至 index.html。配置 HTTPS，上传大小限制与后端一致。缓存带哈希的 assets，index.html 使用短缓存或重新验证，避免部署后仍加载旧页面。

不要把后端 .env 的内容复制进前端环境。可选模型与 OAuth 的详细占位配置见 [backend/.env.example](../backend/.env.example)。

## 数据与备份

SQLite 支持管理员面板中的备份恢复。PostgreSQL 部署需要自行备份数据库及图书存储目录。更新前先在独立目录验证恢复，保留密钥与备份的安全副本；更换加密密钥前先处理已有加密凭据。
