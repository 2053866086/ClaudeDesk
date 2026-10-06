# ClaudeDesk

一个轻量级的 Claude 桌面客户端,支持通过中转 API 或 Anthropic 官方 API 使用 Claude。

## 特性

- 🖥️ 独立桌面窗口,无需浏览器标签页
- 💬 完整的对话管理和历史记录
- 🔄 自动导入 Claude CLI 的对话记录
- 🎨 支持亮色/暗色主题
- 🔒 API Key 仅在本地服务进程中使用,不会发送到浏览器
- ⚡ 自动空闲退出,节省系统资源

## 安装

1. 克隆仓库:
```bash
git clone https://github.com/你的用户名/ClaudeDesk.git
cd ClaudeDesk
```

2. 安装依赖(如果需要):
```bash
# 项目使用 Node.js 内置模块,无需安装额外依赖
```

3. 配置 API:

创建 `data/config.json` 文件:
```json
{
  "baseUrl": "https://your-proxy-api.com/v1",
  "apiKey": "your-api-key",
  "defaultModel": "claude-opus-4-20250514"
}
```

或者使用环境变量:
```bash
export ANTHROPIC_API_KEY=your-api-key
export ANTHROPIC_BASE_URL=https://your-proxy-api.com/v1
```

## 使用

### 方式一:命令行启动
```bash
node server.js
```
然后在浏览器打开 http://127.0.0.1:17860/

### 方式二:桌面应用模式 (Windows)
双击 `launch.vbs` 或桌面快捷方式,会自动启动服务并在独立窗口中打开。

### 方式三:PowerShell 启动
```powershell
.\launch.ps1
```

## 配置说明

配置文件优先级: `data/config.json` > `~/.claude/settings.json` > 环境变量

### config.json 可选字段

- `baseUrl`: API 基础地址
- `apiKey`: API 密钥
- `authToken`: Bearer Token (如果中转 API 需要)
- `customHeaders`: 自定义请求头
- `defaultModel`: 默认模型
- `titleModel`: 用于生成对话标题的模型

### 环境变量

- `CLAUDEDESK_PORT`: 服务端口 (默认 17860)
- `CLAUDEDESK_NO_IDLE`: 设为 1 禁用自动空闲退出
- `ANTHROPIC_API_KEY`: Anthropic API Key
- `ANTHROPIC_BASE_URL`: API 基础地址

## 文件结构

```
ClaudeDesk/
├── server.js          # 后端服务
├── importer.js        # Claude CLI 对话导入器
├── launch.vbs         # Windows 静默启动脚本
├── launch.ps1         # PowerShell 启动脚本
├── icon.ico           # 应用图标
├── public/            # 前端资源
│   ├── index.html
│   ├── app.js
│   ├── style.css
│   └── icon.svg
└── data/              # 数据目录
    ├── config.json    # 配置文件
    ├── settings.json  # 用户设置
    └── conversations/ # 对话记录
```

## 已知问题

- 中转 Haiku 模型响应较慢
- 部分中转 API 可能不完全遵循 system prompt

## 许可

MIT
