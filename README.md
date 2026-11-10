<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="public/aisu-brand.svg">
    <img src="public/aisu-brand-light.svg" alt="爱素书屋" width="100" height="100">
  </picture>
  <h1>爱素书屋</h1>
  <p><strong>把书收藏好，把时间留给阅读。</strong></p>
  <p>一个可以自己部署的阅读空间，收藏小说、漫画与 PDF，读原文、看译文，也可以闭上眼睛听。</p>
  <p>
    <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/License-MIT-987274?style=flat-square"></a>
    <img alt="React 19" src="https://img.shields.io/badge/React-19-6d8a96?style=flat-square">
    <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5d7e99?style=flat-square">
    <img alt="FastAPI" src="https://img.shields.io/badge/FastAPI-658c80?style=flat-square">
    <img alt="Self hosted" src="https://img.shields.io/badge/自部署-私人书库-b68b91?style=flat-square">
  </p>
  <p><a href="#界面预览">界面预览</a> · <a href="#可以做什么">功能</a> · <a href="#本地运行">本地运行</a> · <a href="docs/deployment.md">部署说明</a> · <a href="https://github.com/taffy-owo/aisu-bookhouse-open-source/issues">反馈问题</a></p>
</div>

---

## 界面预览

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/home-dark.png">
  <img src="docs/images/home-light.png" alt="爱素书屋首页：继续阅读、最近阅读与个人书库" width="1440">
</picture>

<table>
  <tr>
    <td width="50%"><img src="docs/images/library.png" alt="书架与分类筛选"><p align="center">把自己的书整理好</p></td>
    <td width="50%"><img src="docs/images/reader.png" alt="夜间阅读与章节目录"><p align="center">让文字回到画面中心</p></td>
  </tr>
</table>

截图书目为《傲慢与偏见》《飘》《小妇人》《简·爱》和《百年孤独》，封面使用维护者提供的图片；阅读页展示《简·爱》英文原文。素材说明见 [截图素材来源](docs/screenshot-sources.md)。账号与阅读记录仅用于本机演示。

## 可以做什么

| 场景 | 功能 |
| --- | --- |
| 收藏与整理 | 私有书架、收藏、系列、标签、搜索、阅读状态，以及由管理员审核的公共书库 |
| 导入自己的书 | EPUB、TXT、MOBI、PDF、漫画压缩包和图片；后台处理任务与原文件下载 |
| 安静阅读 | 字体、字号、行距、纸色与夜间主题；桌面滚动、手机和平板轻点翻页 |
| PDF 与漫画 | 原页查看、缩放、缩略图导航；PDF 文本模式、扫描页回退、夜间纸面与亮度调整 |
| 日文与翻译 | 日文书架、原文阅读辅助、AI 翻译任务、译稿审核与来源更新；需要自行配置模型服务 |
| 听书 | 在线语音与设备朗读；音频临时播放，不在服务器保存音频文件 |
| 阅读记录 | 阅读进度、书签、备注和阅读统计，同一账号可在不同设备间续读 |
| 自部署与集成 | 邀请注册、账号权限、SQLite 备份恢复、OpenAPI、带权限范围的个人 API 与外部发布核验 |

AI、OAuth 和部分在线语音功能依赖相应服务及配置。复杂 EPUB 排版、部分 MOBI 文件和特殊压缩包可能需要回退到原文件查看；这不是电子书排版编辑器。

## 本地运行

需要 **Node.js 22.13+（或 24+）**、**Python 3.11** 和 Git。前后端分别启动；开发模式默认使用 SQLite，无需另装数据库。

### 1. 获取源码

```bash
git clone https://github.com/taffy-owo/aisu-bookhouse-open-source.git
cd aisu-bookhouse-open-source
```

### 2. 启动后端

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
cp .env.example .env
```

先编辑 `backend/.env`，填写自己的管理员邮箱、密码、JWT 密钥与独立加密密钥，再启动：

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

打开终端显示的本地地址（通常为 `http://localhost:5173`），使用刚配置的管理员账号登录，然后上传自己的图书。新数据库默认是空书架；注册需要管理员生成的邀请码。

后端接口文档：`http://127.0.0.1:8000/docs`。

## 技术栈与目录

**前端**：React 19、TypeScript、Vite、Tailwind CSS、PDF.js。  
**后端**：FastAPI、SQLAlchemy、Alembic、SQLite / PostgreSQL。  
**验证**：Vitest、Pytest，以及基于 Chromium 的阅读交互检查。

```text
src/                前端页面、阅读器与共享组件
backend/app/        API、账号、书库、上传、翻译与备份
backend/alembic/    数据库迁移
backend/tests/      后端测试
public/             品牌、图标与自托管字体
scripts/quality/    独立演示数据与浏览器检查
docs/               部署、架构与项目截图
```

SQLite 支持内置整站备份恢复；PostgreSQL 需要自行维护数据库与文件备份。服务器部署、独立 worker 和生产环境配置见 [部署说明](docs/deployment.md)。

## 开发与贡献

```bash
npm run lint
npm test
npm run build
python -m pip install -r backend/requirements-dev.txt
python -m pytest backend/tests
```

浏览器交互检查按需运行，例如 `npm run test:pdf-controls`，需要安装 Chromium、Chrome 或 Edge。

欢迎提交问题与改进，先阅读 [贡献指南](CONTRIBUTING.md)。安全问题请按 [安全说明](SECURITY.md) 私下报告。公开仓库只包含运行源码、必要资源和演示数据；真实图书、账号数据库、密钥、日志、备份与私人运维历史不属于开源内容。

## 致谢与许可

项目首页的组织方式参考 [Best-README-Template](https://github.com/othneildrew/Best-README-Template)、[readme.so](https://github.com/octokatherine/readme.so) 和 [awesome-readme](https://github.com/matiassingers/awesome-readme)。阅读界面的内容层级与交互细节参考 [Kakuyomu](https://kakuyomu.jp/)。

项目代码采用 [MIT License](LICENSE)。第三方库、字体及其许可见 [第三方说明](THIRD_PARTY_NOTICES.md)。本项目不附带第三方电子书、漫画、私人预设或模型凭据；导入内容的使用与授权由部署者自行管理。


