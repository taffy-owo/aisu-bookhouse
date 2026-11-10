# 爱素书屋 API

后端使用 FastAPI、SQLAlchemy 和 Alembic。完整安装步骤见 [项目首页](../README.md#本地运行)，生产环境与 worker 配置见 [部署说明](../docs/deployment.md)。

从本目录运行：

```bash
python -m pip install -r requirements.txt
# 将 .env.example 复制为 .env，填写自己的配置
python -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000 --env-file .env
```

本地 OpenAPI 页面为 http://127.0.0.1:8000/docs；机器可读 schema 为 /api/v1/openapi.json。

默认开发数据库在本目录，上传与解析数据在 ./data。真实数据与 .env 均不应提交到版本控制。SQLite 提供内置备份恢复；PostgreSQL 需要自行维护数据库备份。

测试：

```bash
python -m pip install -r requirements-dev.txt
python -m pytest tests
```

