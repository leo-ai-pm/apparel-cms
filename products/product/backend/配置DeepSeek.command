#!/bin/zsh
set -eu
cd "$(dirname "$0")"

if [[ ! -x .venv/bin/python ]]; then
  echo "未找到 backend/.venv，请先按 backend/README.md 安装依赖。"
  read -k 1 "?按任意键退出..."
  exit 1
fi

.venv/bin/python - <<'PY'
from getpass import getpass
from pathlib import Path
from dotenv import set_key

path = Path('.env')
key = getpass('请输入 DeepSeek API Key（输入不会显示）：').strip()
if not key:
    print('没有输入密钥，配置未改变。')
    raise SystemExit(1)
if not path.exists():
    path.touch(mode=0o600)
set_key(path, 'DEEPSEEK_API_KEY', key)
path.chmod(0o600)
print('已保存在本机 backend/.env。刷新工作台即可尝试真实分析和对话。')
PY

read -k 1 "?按任意键关闭窗口..."
