# Ynote

视频内容提取与 AI 笔记网站，包含网页前端、网站网关后端、本地媒体助手和部署配置。

- 快速提取：FunAudioLLM/SenseVoiceSmall
- 精准提取：Qwen/Qwen3-ASR-1.7B
- AI 笔记：deepseek-ai/DeepSeek-V4.1-Flash
- 平台模型调用共享每日 10 元额度；API Key 仅配置于服务器。
- 媒体下载、音频处理和结果存储优先在访问者本机助手完成。

部署请先阅读 [网站部署说明](先看这里-网站部署.txt) 和 [部署说明](部署说明.md)。

## 目录

- `frontend/`：前端源码及已构建静态页面
- `backend/`：网站 API、模型调用和预算管理
- `companion/`：本地媒体助手源码
- `deploy/`：域名配置、平台验证与启动脚本
- `frontend/dist/downloads/`：Windows 本地助手安装包

本仓库不含平台密钥、用户媒体、任务数据库或本机账本。复制 `.env.example` 并仅在服务器配置凭据；不要提交真实 `.env`。

Docker 镜像与公网 HTTPS 部署尚未完成实际环境验收。第三方许可见 [THIRD_PARTY.md](THIRD_PARTY.md) 和 `licenses/`。
