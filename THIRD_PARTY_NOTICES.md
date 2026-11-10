# 第三方说明

README 截图中的名著封面与公版原文来源、署名和许可见 [截图素材来源](docs/screenshot-sources.md)。

项目原创代码使用根目录 MIT 许可。第三方软件、字体仍遵循各自许可，不因项目采用 MIT 而改变。

## 自托管字体

| 字体 | 来源 | 许可文件 |
| --- | --- | --- |
| Inter | https://github.com/rsms/inter | [SIL OFL 1.1](docs/licenses/Inter-OFL.txt) |
| Noto Serif SC | https://github.com/notofonts/noto-cjk | [SIL OFL 1.1](docs/licenses/NotoSerifSC-OFL.txt) |
| Noto Serif JP | https://github.com/notofonts/noto-cjk | [SIL OFL 1.1](docs/licenses/NotoSerifJP-OFL.txt) |
| LXGW WenKai | https://github.com/lxgw/LxgwWenKai，通过 @hanzi.pro/webfonts-lxgw-wenkai 加载 | [SIL OFL 1.1](docs/licenses/LXGWWenKai-OFL.txt) |

字体许可、版权声明和保留字体名称见对应文件。依赖中的字体由包管理器安装，不在源码中重复打包。

## 软件依赖

前端依赖和版本记录在 package.json、package-lock.json；后端记录在 backend/requirements*.txt 与锁文件。React、Vite、Tailwind CSS、PDF.js、FastAPI、SQLAlchemy、Alembic 等第三方项目分别保留自己的许可。安装或分发打包版本时请一并遵守依赖许可。
