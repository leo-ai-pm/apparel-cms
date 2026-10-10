"""Explicit HTTPS deployment behind a loopback BFF; never imports old state."""
import argparse
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys

ORIGIN = 'https://s357brv8j8f9gdhvbu9a9.apigateway-cn-beijing.volceapi.com'
INSTANCE = 'styling-public-20261010'
SCOPE = 'public-three-agent-20261010'
ALLOWED = {
    'STYLING_ADMIN_SECRET', 'STYLING_ADMIN_PASSWORD', 'STYLING_ADMIN_PUBLIC_ORIGIN',
    'STYLING_DEMO_ACCESS_ENABLED', 'STYLING_FIXED_OFFLINE_DEMO', 'STYLING_FIXED_MODEL_CALL_LIMIT',
    'DEEPSEEK_API_KEY', 'DEEPSEEK_MODEL', 'DEEPSEEK_BASE_URL', 'YIXU_MODEL_PROVIDER',
    'DAILY_CALL_LIMIT', 'MAX_CONCURRENCY', 'STYLING_DIRECT_ENABLED', 'STYLING_DIRECT_AUTH_FILE',
    'STYLING_PERSONAL_PREVIEW_ENABLED', 'STYLING_PERSONAL_PREVIEW_REAL_AUTHORIZED',
    'STYLING_PERSONAL_PREVIEW_WORKER_AUTORUN', 'RUNNINGHUB_API_KEY',
}
PAIRING_FIELDS = {'session_secret', 'product_workbench_reader', 'styling_sender', 'styling_product_verifier',
                  'design_package_reader', 'design_event_writer', 'design_asset_reader'}


def checked_path(value):
    path = Path(value).expanduser().absolute()
    if any(p.is_symlink() for p in (path, *path.parents)):
        raise RuntimeError('Deployment paths must not use symlinks')
    return path


def configuration(path, allowed=ALLOWED):
    path = checked_path(path)
    info = path.stat()
    if not path.is_file() or info.st_mode & 0o077 or info.st_nlink != 1 or info.st_size > 65536:
        raise RuntimeError('Use a private regular 0600 config file')
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError()
            result[key] = value
        return result
    try:
        value = json.loads(path.read_text(), object_pairs_hook=pairs)
        if not isinstance(value, dict) or set(value) - allowed or any(not isinstance(v, str) for v in value.values()):
            raise ValueError()
    except (ValueError, UnicodeError):
        raise RuntimeError('Invalid deployment config schema') from None
    return value


def pairing_configuration(path):
    value = configuration(path, PAIRING_FIELDS)
    if set(value) != PAIRING_FIELDS or any(not 24 <= len(v) <= 512 or any(c.isspace() or ord(c) < 32 or ord(c) == 127 for c in v) for v in value.values()):
        raise RuntimeError('Invalid root pairing schema')
    if len(value['session_secret']) < 32:
        raise RuntimeError('Invalid root session signing key')
    return value


def direct_configuration(pairing):
    return {'targets': [{'enabled': True, 'authorized_scope': SCOPE, 'source_instance_id': INSTANCE,
              'target_instance_id': 'product-public-20261010', 'base_url': 'http://127.0.0.1:8191',
              'sender_token': pairing['styling_sender']}],
            'verifiers': [{'enabled': True, 'authorized_scope': SCOPE, 'source_instance_id': INSTANCE,
              'target_instance_id': 'product-public-20261010', 'subject': 'product-public-verifier',
              'token_sha256': hashlib.sha256(pairing['styling_product_verifier'].encode()).hexdigest()}]}


def environment(backend, data, config):
    for key in tuple(os.environ):
        if key.startswith(('STYLING_', 'CONSUMER_', 'CMS_', 'DEEPSEEK_', 'RUNNINGHUB_', 'TUDOU_',
                           'DASHSCOPE_', 'OPENAI_', 'YIXU_')) or key in ('DATABASE_URL', 'DATA_DIR', 'PRODUCT_IMAGE_DIR'):
            os.environ.pop(key, None)
    origin = config.get('STYLING_ADMIN_PUBLIC_ORIGIN', ORIGIN)
    os.environ.update({
        'PYTHON_DOTENV_DISABLED': '1', 'PYTHONDONTWRITEBYTECODE': '1',
        'DATABASE_URL': 'sqlite:///'+str(data/'app.db'), 'DATA_DIR': str(data),
        'PRODUCT_IMAGE_DIR': str(data/'product-images'),
        'STYLING_ADMIN_ENABLED': '1', 'STYLING_ADMIN_CONTEXT_ENABLED': '1',
        'STYLING_ADMIN_SUBJECT': INSTANCE, 'STYLING_ADMIN_SCOPE': SCOPE,
        'STYLING_DIRECT_INSTANCE_ID': INSTANCE, 'STYLING_ADMIN_PUBLIC_ORIGIN': origin,
        'STYLING_ADMIN_COOKIE_NAME': 'styling_admin_public_20261010', 'STYLING_ADMIN_COOKIE_SECURE': '1',
        'CONSUMER_APP_SCOPE': INSTANCE, 'CONSUMER_ALLOWED_ORIGINS': origin, 'CONSUMER_COOKIE_SECURE': '1',
        'STYLING_PUBLIC_DEMO_SUBJECT': INSTANCE, 'STYLING_PUBLIC_DEMO_SCOPE': SCOPE,
        'STYLING_PUBLIC_DEMO_INSTANCE_ID': INSTANCE,
        'STYLING_DEMO_ACCESS_ENABLED': '1', 'STYLING_DEMO_ACCESS_MODE': 'public',
        'STYLING_FIXED_ENABLED': '1', 'STYLING_FIXED_ROOT': str(data/'fixed-resources'),
        'STYLING_FIXED_DB': str(data/'fixed-outfits.sqlite3'),
        'STYLING_FIXED_MODEL_CALL_LIMIT': '12', 'STYLING_FIXED_OFFLINE_DEMO': '1',
        'STYLING_PRODUCT_IMAGE_PREVIEW': '1',
        'STYLING_PRODUCT_IMAGE_MANIFEST': str(backend/'deploy_resources/single-products/product-image-manifest-v1.json'),
        'STYLING_PRODUCT_IMAGE_DB': str(data/'product-image.sqlite3'),
        'STYLING_PERSONAL_PREVIEW_ENABLED': '0', 'STYLING_PERSONAL_PREVIEW_ISOLATED': '0',
        'STYLING_PERSONAL_PREVIEW_PROVIDER': 'runninghub', 'STYLING_PERSONAL_PREVIEW_WORKER_AUTORUN': '0',
        'STYLING_PERSONAL_PREVIEW_DIR': str(data/'private-preview'),
        'STYLING_PERSONAL_PREVIEW_DB': str(data/'private-preview/preview.sqlite3'),
        'STYLING_PERSONAL_PREVIEW_REAL_AUTHORIZED': '0', 'STYLING_PERSONAL_PREVIEW_REAL_TOTAL_LIMIT': '1',
        'STYLING_PERSONAL_PREVIEW_DAILY_LIMIT': '1', 'STYLING_DIRECT_ENABLED': '0',
        'STYLING_DIRECT_AUTH_FILE': '', 'STYLING_DIRECT_ALLOW_LOOPBACK_HTTP': '1',
        'STYLING_DEMAND_RECEIVER_URL': '', 'STYLING_DEMAND_RECEIVER_KEY': '',
        'STYLING_DEMAND_D3_ENABLED': '0', 'STYLING_DEMAND_AUTO_RETRY': '0',
        'CMS_BASE_URL': '', 'CMS_API_KEY': '', 'TUDOU_API_KEY': '', 'DASHSCOPE_API_KEY': '',
        'OPENAI_API_KEY': '', 'DEEPSEEK_API_KEY': '', 'RUNNINGHUB_API_KEY': '',
        'YIXU_MODEL_PROVIDER': 'deepseek', 'YIXU_API_KEY_FILE': '', 'YIXU_MODEL_CONFIG': '',
        'DEEPSEEK_BASE_URL': 'https://api.deepseek.com', 'DEEPSEEK_MODEL': 'deepseek-v4-flash',
        'DAILY_CALL_LIMIT': '12', 'MAX_CONCURRENCY': '1', 'LLM_RETRIES': '0',
    })
    os.environ.update(config)
    if len(os.getenv('STYLING_ADMIN_SECRET', '')) < 32:
        raise RuntimeError('A new server signing secret is required')
    if os.getenv('STYLING_DEMO_ACCESS_ENABLED') not in ('0', '1') or os.getenv('STYLING_FIXED_OFFLINE_DEMO') not in ('0', '1'):
        raise RuntimeError('Explicit binary deployment switches required')
    if os.getenv('STYLING_DEMO_ACCESS_ENABLED') == '0' and len(os.getenv('STYLING_ADMIN_PASSWORD', '')) < 12:
        raise RuntimeError('Normal authentication needs its own server password')
    if os.getenv('STYLING_FIXED_OFFLINE_DEMO') == '0' and (
            os.getenv('YIXU_MODEL_PROVIDER') != 'deepseek' or not os.getenv('DEEPSEEK_API_KEY')
            or os.getenv('DEEPSEEK_BASE_URL') != 'https://api.deepseek.com'):
        raise RuntimeError('Live text requires explicit official provider credentials')
    if os.getenv('STYLING_PERSONAL_PREVIEW_ENABLED') == '1' and (
            os.getenv('STYLING_PERSONAL_PREVIEW_REAL_AUTHORIZED') != '1' or not os.getenv('RUNNINGHUB_API_KEY')):
        raise RuntimeError('Personal images require explicit provider authorization and credentials')
    if not 1 <= int(os.environ['STYLING_FIXED_MODEL_CALL_LIMIT']) <= 12 or not 1 <= int(os.environ['DAILY_CALL_LIMIT']) <= 200:
        raise RuntimeError('Deployment call limits are invalid')
    sys.path.insert(0, str(backend))
    from app.core.admin_auth import _demo_origin
    _demo_origin()  # Validate frozen HTTPS/scope policy even when restoring normal login.


def verify_assets(backend):
    for folder, manifest_name in [('demo_resources', 'PUBLIC_MANIFEST.json'),
                                  ('deploy_resources', 'DEPLOY_ASSETS_MANIFEST.json')]:
        root = backend/folder
        manifest = json.loads((root/manifest_name).read_text())
        for relative, record in manifest['files'].items():
            path = checked_path(root/relative)
            if root not in path.parents or hashlib.sha256(path.read_bytes()).hexdigest() != record['sha256']:
                raise RuntimeError('Deployment asset integrity failed')


def initialize(backend, data, pairing=None):
    if data.exists():
        raise RuntimeError('Initialize requires a completely new data directory; existing state is never reset')
    verify_assets(backend)
    data.mkdir(mode=0o700, parents=True)
    if pairing:
        (data/'direct-auth.json').write_text(json.dumps(direct_configuration(pairing), indent=2)+'\n')
    shutil.copytree(backend/'demo_resources', data/'fixed-resources', ignore=shutil.ignore_patterns('__pycache__'))
    shutil.copyfile(backend/'deploy_resources/product_visual_specs.json', data/'fixed-resources/data/m1_v2/product_visual_specs.json')
    now = datetime.now(timezone.utc)
    shutil.copytree(backend/'deploy_resources/source-products', data/'product-images')
    (data/'private-preview').mkdir(mode=0o700)
    from app.core.database import init_db
    init_db()
    from app.services import fixed_styling, product_image_assets
    # Initialization performs no model call; resource registration is deterministic.
    configured = os.environ['STYLING_FIXED_OFFLINE_DEMO']
    os.environ['STYLING_FIXED_OFFLINE_DEMO'] = '1'
    try:
        service = fixed_styling.get_service()
        product_image_assets.register_manifest(service.resources())
        inventory_time = {k: service.resources().inventory[k] for k in
                          ('inventory_snapshot_id', 'captured_at', 'valid_until')}
    finally:
        fixed_styling.close_service(); os.environ['STYLING_FIXED_OFFLINE_DEMO'] = configured
    marker = {'schema': 'styling_https_deployment_v1', 'instance': INSTANCE, 'scope': SCOPE,
              'created_at': now.isoformat(), 'inventory_time': inventory_time,
              'source_inventory_sha256': hashlib.sha256((backend/'demo_resources/data/m1_v2/inventory.json').read_bytes()).hexdigest(),
              'paid_calls_during_initialization': 0, 'private_history_imported': False}
    (data/'deployment-state.json').write_text(json.dumps(marker, indent=2)+'\n')
    return marker


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config-file')
    parser.add_argument('--pairing-file')
    parser.add_argument('--data-dir', required=True)
    parser.add_argument('--port', type=int, default=8190)
    parser.add_argument('--initialize', action='store_true')
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        raise RuntimeError('Invalid loopback port')
    os.umask(0o077)
    backend = Path(__file__).resolve().parents[1]
    data = checked_path(args.data_dir)
    config = configuration(args.config_file) if args.config_file else {}
    pairing = pairing_configuration(args.pairing_file) if args.pairing_file else None
    if pairing:
        if config.get('STYLING_ADMIN_SECRET', pairing['session_secret']) != pairing['session_secret'] or config.get('STYLING_DIRECT_AUTH_FILE'):
            raise RuntimeError('Use the root pairing keys without conflicting service credentials')
        config.update({'STYLING_ADMIN_SECRET': pairing['session_secret'],
                       'STYLING_DIRECT_ENABLED': '1', 'STYLING_DIRECT_AUTH_FILE': str(data/'direct-auth.json')})
    environment(backend, data, config)
    if args.initialize:
        print(json.dumps(initialize(backend, data, pairing)), flush=True)
        return
    if not data.is_dir() or data.stat().st_mode & 0o077:
        raise RuntimeError('An initialized private 0700 deployment directory is required')
    marker = json.loads((data/'deployment-state.json').read_text())
    if marker.get('instance') != INSTANCE or marker.get('scope') != SCOPE or marker.get('schema') != 'styling_https_deployment_v1':
        raise RuntimeError('Deployment instance marker does not match')
    if pairing:
        direct = checked_path(data/'direct-auth.json')
        if not direct.is_file() or direct.stat().st_mode & 0o077 or json.loads(direct.read_text()) != direct_configuration(pairing):
            raise RuntimeError('Persistent direct configuration does not match root pairing; do not auto-rotate')
    from app.main import app
    import uvicorn
    # Forwarded values never choose scheme, client identity or cookie security.
    uvicorn.run(app, host='127.0.0.1', port=args.port, proxy_headers=False, workers=1,
                access_log=False, log_level='warning')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('HTTPS deployment configuration or initialization failed; inspect private configuration locally.', file=sys.stderr)
        raise SystemExit(1) from None
