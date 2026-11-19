# 🚗 MoveCar - Cloudflare Workers 简易扫码挪车通知系统

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Deploy to Cloudflare Workers](https://img.shields.io/badge/Deploy-Cloudflare%20Workers-orange?logo=cloudflare)](https://dash.cloudflare.com/)

一个基于 **Cloudflare Workers** 和 **KV 存储** 构建的高效、无服务器（Serverless）挪车通知系统。

扫码即可上传现场照片并呼叫车主，支持通过 **企业微信 (WeCom)** 及 **Bark** 实时推送消息。车主可在线查看照片并一键快捷回复（马上赶来、重拍照片、拒绝等），回复状态实时同步至申请端。

---

## ✨ 核心特性

- ⚡ **无服务器极速响应**：基于 Cloudflare Workers 全球边缘计算网络部署，零服务器成本，高可用。
- 📷 **强制现场照片上传**：支持防伪及环境核验，必须现场拍照/上传图片方可发起通知。
- 💬 **显眼图标与快捷标签**：申请页内置“挡路”、“临停”等快捷标签；回复结果配有大号显眼 Emoji 图标展示。
- 📋 **当日申请记录管理**：
  - **自动跨天清理**：基于北京时间（Asia/Shanghai）生成记录，利用 KV TTL（24小时）在次日自动过期删除历史数据。
  - **分页加载优化**：申请端与车主端默认仅展示最近 3 条记录，支持点击“查看更多”逐次加载 3 条，提升页面性能。
- 🏃 **车主独立确认页**：
  - 支持车主查看当日所有挪车申请列表，精准选择特定记录进行独立回复。
  - 无论申请端页面是否关闭，只要车主完成回复，系统均能持久化保存记录。
- 🔒 **隐私保护与阶梯防打扰**：
  - 发送通知页面默认隐藏拨打电话按钮，需连续点击 3 次“再次通知”方可解锁直接打电话按钮。
- 🔔 **多通道实时推送**：集成企业微信应用（WeCom）与 Bark 关键级推送（包含带参直达链接），并支持灵活配置推送接收范围。

---

## 🛠️ 技术栈

- **后端/前端**：Cloudflare Workers (JavaScript, HTML-in-JS 渲染)
- **数据存储**：Cloudflare KV
- **推送服务**：企业微信应用消息 API (WeCom API)、Bark Push Service

---

## 🚀 部署指南

### 1. 创建 Cloudflare KV 命名空间

在 Cloudflare 控制台或使用 Wrangler 创建一个 KV 命名空间：

- **绑定变量名**：`MOVE_CAR_STATUS`

### 2. 配置环境变量 (Environment Variables)

在 Cloudflare Worker 的设置 -> 变量 (Variables) 中添加以下变量：

| 变量名 | 必填 | 默认值 | 示例 / 说明 |
| :--- | :---: | :---: | :--- |
| `PHONE_NUMBER` | 是 | 无 | `13800138000`（车主电话，解锁直接拨打后使用） |
| `WECOM_CORPID` | 否 | 无 | 企业微信 CorpID |
| `WECOM_APP_SECRET` | 否 | 无 | 企业微信应用 Secret |
| `WECOM_AGENTID` | 否 | 无 | 企业微信应用 AgentID |
| `WECOM_TOUSER` | 否 | `@all` | 推送接收成员账号；留空或未设置默认 `@all`，单人填如 `yxl`，多人用 `&` 隔开如 `user1&user2` |
| `BARK_URL` | 否 | 无 | Bark 推送地址（如 `https://api.day.app/YOUR_KEY`） |

> **注意**：请确保已将 KV 命名空间绑定为 `MOVE_CAR_STATUS`。

### 3. 发布代码

将 `movecar.js` 的完整代码复制并粘贴至 Cloudflare Worker 编辑器中，保存并部署即可。

---

## 📱 页面路由与 API 说明

### 页面路由 (Routes)

- `/`：挪车申请主页，支持填写留言、上传现场照片、查看车主回复及浏览当日记录。
- `/owner-confirm`：车主专用确认与回复页面，支持查看当日申请列表、切换选中记录并发送回复（支持 `?id=xxx` 参数定位对应记录）。

### 后端 API

- **`POST /api/notify`**：提交挪车申请（`multipart/form-data`，包含 `message` 与 `image`）。
- **`POST /api/owner-confirm`**：车主提交回复（JSON 格式，包含 `recordId` 与 `reply`）。
- **`GET /api/check-status`**：申请端轮询最新通知与车主回复状态。
- **`GET /api/get-car-data`**：获取最新待确认记录的照片与留言。
- **`GET /api/get-today-records`**：获取当日所有的挪车申请及回复记录列表。

---

## 📄 开源协议

本项目基于 [MIT License](LICENSE) 协议开源。
