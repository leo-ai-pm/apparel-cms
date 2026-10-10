"""Portable offline demo. Uses new private local state, never another instance's DB."""
import argparse
import json
import os
from pathlib import Path
import secrets
import sys


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=8000)
    parser.add_argument('--public-origin', default='http://localhost:3000')
    parser.add_argument('--data-dir', type=Path, default=Path.home()/'.local/share/personal-styling-agent-demo')
    parser.add_argument('--demo-access', action=argparse.BooleanOptionalAction,
                        default=os.getenv('STYLING_DEMO_ACCESS_ENABLED','0') == '1')
    args = parser.parse_args()
    os.umask(0o077)
    backend = Path(__file__).resolve().parents[1]
    data = args.data_dir.expanduser().resolve()
    data.mkdir(mode=0o700, parents=True, exist_ok=True)
    if data.is_symlink() or data.stat().st_mode & 0o077:
        raise RuntimeError('Use a private 0700 data directory')
    auth = data/'local-auth.json'
    if not auth.exists():
        with auth.open('x') as output:
            json.dump({'password': secrets.token_urlsafe(24), 'secret': secrets.token_urlsafe(48)}, output)
    if auth.is_symlink() or auth.stat().st_mode & 0o077:
        raise RuntimeError('Local auth file must be private 0600')
    values = json.loads(auth.read_text())
    for key in tuple(os.environ):
        if key.endswith(('_API_KEY','_API_KEY_FILE')) or key.lower() in ('http_proxy','https_proxy','all_proxy'):
            os.environ.pop(key, None)
    os.environ.update({
        'PYTHON_DOTENV_DISABLED':'1', 'PYTHONDONTWRITEBYTECODE':'1',
        'DATABASE_URL':'sqlite:///'+str(data/'app.db'), 'DATA_DIR':str(data),
        'PRODUCT_IMAGE_DIR':str(data/'product-images'),
        'CONSUMER_APP_SCOPE':'public_styling_demo', 'CONSUMER_ALLOWED_ORIGINS':args.public_origin,
        'STYLING_ADMIN_ENABLED':'1', 'STYLING_ADMIN_CONTEXT_ENABLED':'1',
        'STYLING_ADMIN_SUBJECT':'styling-local-manager', 'STYLING_ADMIN_SCOPE':'public-styling-demo',
        'STYLING_DIRECT_INSTANCE_ID':'styling-public-demo',
        'STYLING_ADMIN_PASSWORD':values['password'], 'STYLING_ADMIN_SECRET':values['secret'],
        'STYLING_ADMIN_PUBLIC_ORIGIN':args.public_origin, 'STYLING_ADMIN_COOKIE_NAME':'styling_admin_public_demo',
        'STYLING_ADMIN_COOKIE_SECURE':'0', 'STYLING_DEMO_ACCESS_ENABLED':'1' if args.demo_access else '0',
        'STYLING_FIXED_ENABLED':'1', 'STYLING_FIXED_ROOT':str(backend/'demo_resources'),
        'STYLING_FIXED_DB':str(data/'fixed-outfits.sqlite3'), 'STYLING_FIXED_MODEL_CALL_LIMIT':'1',
        'STYLING_FIXED_OFFLINE_DEMO':'1', 'STYLING_PRODUCT_IMAGE_PREVIEW':'0',
        'STYLING_PERSONAL_PREVIEW_ENABLED':'0', 'STYLING_PERSONAL_PREVIEW_WORKER_AUTORUN':'0',
        'CMS_BASE_URL':'', 'CMS_API_KEY':'', 'STYLING_DIRECT_ENABLED':'0', 'STYLING_DIRECT_AUTH_FILE':'',
        'STYLING_DEMAND_RECEIVER_URL':'', 'STYLING_DEMAND_RECEIVER_KEY':'',
        'STYLING_DEMAND_D3_ENABLED':'0', 'STYLING_DEMAND_AUTO_RETRY':'0',
        'DEEPSEEK_API_KEY':'', 'TUDOU_API_KEY':'', 'RUNNINGHUB_API_KEY':'',
        'DASHSCOPE_API_KEY':'', 'OPENAI_API_KEY':'', 'YIXU_API_KEY_FILE':'',
    })
    sys.path.insert(0, str(backend))
    from app.main import app
    from app.core.consumer_identity import consumer_cookie_name
    import uvicorn
    print(json.dumps({'backend_url':f'http://127.0.0.1:{args.port}', 'public_origin':args.public_origin,
        'consumer_cookie_name':consumer_cookie_name(), 'admin_cookie_name':'styling_admin_public_demo',
        'mode':'offline_controlled_no_model_http', 'demo_access':args.demo_access,
        'personal_photo_enabled':False, 'partner_sending_configured':False}), flush=True)
    uvicorn.run(app, host='127.0.0.1', port=args.port, access_log=False, log_level='warning')


if __name__ == '__main__':
    main()
