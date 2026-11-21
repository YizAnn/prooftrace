/* 本机启动脚本：只设置非敏感默认值。
   密钥优先从 Windows 凭据（DPAPI）读取；也可用 AI_API_KEY 或 AI_API_KEY_FILE 环境变量提供。
   脚本不保存任何密钥或具体密钥路径。 */
process.env.AI_API_BASE = process.env.AI_API_BASE || 'https://dashscope.aliyuncs.com/compatible-mode/v1';
process.env.AI_MODEL = process.env.AI_MODEL || 'qwen-plus';
process.env.PORT = process.env.PORT || '8787';
process.env.HOST = process.env.HOST || '127.0.0.1';

/* 显式调用统一启动入口。此前直接 require('./server.js') 会被 require.main 判断挡住，
   导致 run_local.js 退出但 8787 端口没有监听。 */
const started = require('./server.js').startServer();
module.exports = started;
