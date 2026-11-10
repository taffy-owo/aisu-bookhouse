<div align="center">
  <img src="docs/images/readme-banner.svg" alt="爱素书屋：把喜欢的故事，留在自己的书架。" width="100%">
  <h1>爱素书屋</h1>
  <p><strong>一间属于自己的在线书屋。</strong></p>
  <p>收藏小说、漫画与 PDF，在自己的服务器上阅读、翻译和听书。</p>
  <p>
    <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/License-MIT-987274?style=flat-square"></a>
    <img alt="React 19" src="https://img.shields.io/badge/React-19-6d8a96?style=flat-square">
    <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5d7e99?style=flat-square">
    <img alt="FastAPI" src="https://img.shields.io/badge/FastAPI-658c80?style=flat-square">
  </p>
  <p><a href="#界面预览">界面预览</a> · <a href="#功能">功能一览</a> · <a href="#本地运行">开始使用</a> · <a href="docs/deployment.md">自部署指南</a> · <a href="https://github.com/taffy-owo/aisu-bookhouse/issues">反馈问题</a></p>
</div>

## 从书架，回到故事里

把散落的电子书放进同一个书库，按标签、系列与阅读状态整理；再次打开时，从上次读到的位置继续。

<table>
  <tr>
    <td width="33%" valign="top"><strong>01 / 收藏与整理</strong><br><br>导入多种格式，搜索、收藏、标记阅读状态，为每本书找到位置。</td>
    <td width="33%" valign="top"><strong>02 / 按自己的节奏读</strong><br><br>调整字体、行距与纸色，切换日夜主题，使用书签、备注与章节目录。</td>
    <td width="33%" valign="top"><strong>03 / 换一种方式继续</strong><br><br>使用翻译、日文阅读辅助或听书，登录同一账号跨设备续读。</td>
  </tr>
</table>

## 界面预览

### 打开书屋，接着上次的阅读

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/home-dark.png">
  <img src="docs/images/home-light.png" alt="首页：继续阅读、阅读统计与最近翻过的图书" width="1440">
</picture>

<p align="center"><sub>首页跟随明暗主题展示。点击图片可查看大图。</sub></p>

<table>
  <tr>
    <td width="50%" valign="top"><a href="docs/images/library.png"><img src="docs/images/library.png" alt="书架：浏览藏书、搜索与筛选"></a><p><strong>整理你的藏书</strong><br><sub>在书架中浏览、筛选与管理阅读状态。</sub></p></td>
    <td width="50%" valign="top"><a href="docs/images/reader.png"><img src="docs/images/reader.png" alt="夜间阅读器与章节目录"></a><p><strong>留一点安静给阅读</strong><br><sub>夜间主题与章节目录，让故事继续。</sub></p></td>
  </tr>
</table>

## 功能

| 阅读环节 | 可以做什么 |
| --- | --- |
| **导入图书** | 支持 EPUB、TXT、MOBI、PDF、ZIP/CBZ 漫画压缩包和图片 |
| **整理书架** | 搜索、收藏、标签、系列分组和阅读状态；可将图书提交到公共书库 |
| **阅读小说** | 调整字体、字号、行距和背景，切换日间与夜间主题；支持滚动阅读和轻点翻页 |
| **阅读 PDF** | 原页缩放、缩略图导航、文本阅读、纸色和亮度调整 |
| **阅读漫画与图片** | 逐页阅读、缩放和页码跳转 |
| **日文与翻译** | 日文阅读辅助、整书翻译、译稿审核和来源更新，需自行配置模型服务 |
| **听书** | 支持在线语音和设备朗读，可调节语速 |
| **接续阅读** | 保存阅读进度、书签和备注，登录同一账号即可跨设备续读 |
| **账号与管理** | 邀请注册、权限管理、SQLite 备份恢复和个人 API |

想先在电脑上试用，可以从下面的本地运行开始；准备放到自己的服务器上，请看 [自部署指南](docs/deployment.md)。

## 本地运行

需要 **Node.js 22.13+（或 24+）**、**Python 3.11** 和 Git。默认使用 SQLite，无需另装数据库。

### 1. 获取源码

```bash
git clone https://github.com/taffy-owo/aisu-bookhouse.git
cd aisu-bookhouse
```

### 2. 启动后端

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
cp .env.example .env
```

编辑 `backend/.env`，填写管理员邮箱、密码、JWT 密钥和加密密钥，然后启动：

```bash
python -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000 --env-file .env
```

<details>
<summary>Windows PowerShell</summary>

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
Copy-Item .env.example .env
# 编辑 .env 后启动
python -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000 --env-file .env
```

</details>

### 3. 启动前端

另开一个终端，在项目根目录执行：

```bash
npm ci
cp .env.example .env.local
npm run dev
```

PowerShell 使用 `Copy-Item .env.example .env.local` 复制配置。

打开终端显示的地址（通常为 `http://localhost:5173`），用配置好的管理员账号登录并上传图书。其他用户需要邀请码注册，管理员可以在网站中创建邀请码。

整书翻译和定时检查来源更新还需要启动 [后台 worker](docs/deployment.md#服务与-worker)。

服务器部署、独立 worker 和生产环境配置见 [部署说明](docs/deployment.md)。后端接口文档位于 `http://127.0.0.1:8000/docs`。

## 开发

前端使用 React、TypeScript、Vite 和 Tailwind CSS；后端使用 FastAPI、SQLAlchemy 和 Alembic，支持 SQLite 与 PostgreSQL。

```text
src/                前端页面与阅读器
backend/app/        后端 API 与业务逻辑
backend/alembic/    数据库迁移
backend/tests/      后端测试
public/             图标与字体
docs/               部署文档与截图
```

```bash
npm run lint
npm test
npm run build
python -m pip install -r backend/requirements-dev.txt
cd backend
python -m pytest tests
```

提交问题或参与开发，请看 [贡献指南](CONTRIBUTING.md)。安全问题请按 [安全说明](SECURITY.md) 私下报告。

## 许可

[MIT License](LICENSE) · [第三方许可](THIRD_PARTY_NOTICES.md)
