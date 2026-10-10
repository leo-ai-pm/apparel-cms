"""Server-only provider configuration. Never executes or copies credential files."""
import json
import os
from pathlib import Path
from .core import Fault

PRESETS = {
    'qwen': ('DASHSCOPE_API_KEY', 'https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen3.7-plus'),
    'deepseek': ('DEEPSEEK_API_KEY', 'https://api.deepseek.com', 'deepseek-v4-flash'),
    'compatible': ('OPENAI_API_KEY', '', ''),
}


def read_key_file(path, name):
    try:
        for line in Path(path).expanduser().read_text().splitlines():
            line = line.strip().removeprefix('export ')
            key, sep, value = line.partition('=')
            if sep and key.strip() == name:
                value = value.strip()
                if len(value) >= 2 and value[0] in ['"', "'"] and value[-1] == value[0]:
                    value = value[1:-1]
                return value
    except (OSError, UnicodeError):
        raise Fault('MODEL_CONFIGURATION_INVALID', '无法读取本地模型凭据文件。') from None
    return ''


def load_config():
    # An explicit environment provider is a complete selection, never a merge of
    # one provider's key with another provider's local base URL.
    provider = os.environ.get('YIXU_MODEL_PROVIDER', '')
    if not provider:
        if os.environ.get('OPENAI_API_KEY'): provider = 'compatible'
        elif os.environ.get('DASHSCOPE_API_KEY'): provider = 'qwen'
        elif os.environ.get('DEEPSEEK_API_KEY'): provider = 'deepseek'
    local = {}
    if not provider:
        path = Path(os.environ.get('YIXU_MODEL_CONFIG', '~/.config/yixu/model.json')).expanduser()
        try:
            if path.exists(): local = json.loads(path.read_text())
        except (OSError, ValueError):
            raise Fault('MODEL_CONFIGURATION_INVALID', '本地模型配置文件无法解析。') from None
        if type(local) is not dict or set(local) - {'provider', 'base_url', 'model', 'api_key_env_file'} or any(type(v) is not str for v in local.values()):
            raise Fault('MODEL_CONFIGURATION_INVALID', '本地模型配置字段不正确，密钥应保存在独立凭据文件。')
        provider = local.get('provider', 'compatible')
    if provider not in PRESETS:
        raise Fault('MODEL_CONFIGURATION_INVALID', '模型服务商应为 qwen、deepseek 或 compatible。')
    key_name, base, model = PRESETS[provider]
    prefix = {'qwen': 'QWEN', 'deepseek': 'DEEPSEEK', 'compatible': 'OPENAI'}[provider]
    key = os.environ.get(key_name, '')
    key_file = os.environ.get('YIXU_API_KEY_FILE', '') or local.get('api_key_env_file', '')
    if not key and key_file: key = read_key_file(key_file, key_name)
    return dict(provider=provider, key=key,
                base=os.environ.get(prefix+'_BASE_URL') or local.get('base_url') or base,
                name=os.environ.get(prefix+'_MODEL') or local.get('model') or model)
