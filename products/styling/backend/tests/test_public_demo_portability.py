"""A real TCP service started from a detached source copy without the outer project."""
import hashlib
import http.cookiejar
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request


def test_clone_can_start_enter_read_assets_and_restore_authentication(tmp_path):
    backend = Path(__file__).resolve().parents[1]
    clone = tmp_path/'detached'/'backend'
    clone.mkdir(parents=True)
    shutil.copytree(backend/'app', clone/'app', ignore=shutil.ignore_patterns('__pycache__'))
    shutil.copytree(backend/'demo_resources', clone/'demo_resources', ignore=shutil.ignore_patterns('__pycache__'))
    (clone/'scripts').mkdir()
    shutil.copyfile(backend/'scripts/start_public_demo.py', clone/'scripts/start_public_demo.py')
    assert not (clone/'.env').exists()
    state = tmp_path/'private-state'
    with socket.socket() as reserve:
        reserve.bind(('127.0.0.1',0));port = reserve.getsockname()[1]
    origin = f'http://127.0.0.1:{port}'
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(jar))
    evidence = {'layer':'real_tcp_detached_source_copy','http':[],'paid_http':0,
                'original_project_path_in_process_environment':False, 'service_starts':0}
    def request(path, body=None):
        req = urllib.request.Request(origin+path, data=json.dumps(body).encode() if body is not None else None,
            headers={'Origin':origin, 'Content-Type':'application/json'})
        try:
            r = opener.open(req,timeout=5)
        except urllib.error.HTTPError as e:
            r = e
        with r:
            raw = r.read();ctype = r.headers.get('Content-Type','')
            value = json.loads(raw) if 'json' in ctype else raw
            evidence['http'].append({'path':path,'method':'POST' if body is not None else 'GET','status':r.status})
            return r.status, value, r.headers
    def start(demo):
        p = subprocess.Popen([sys.executable,str(clone/'scripts/start_public_demo.py'), '--port',str(port),
            '--public-origin',origin,'--data-dir',str(state),'--demo-access' if demo else '--no-demo-access'],
            cwd=clone,env={'PATH':os.getenv('PATH',''),'LANG':'en_US.UTF-8','PYTHON_DOTENV_DISABLED':'1'},
            stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        evidence['service_starts'] += 1
        for _ in range(100):
            if p.poll() is not None:
                raise AssertionError('detached demo failed to start')
            try:
                with socket.create_connection(('127.0.0.1',port),timeout=.1):
                    return p
            except OSError:
                time.sleep(.05)
        p.terminate();p.wait(timeout=5)
        raise AssertionError('detached demo did not listen')
    p = start(True)
    try:
        status, health, _ = request('/api/v1/health')
        assert status == 200 and health['generation']['mode'] == 'offline_controlled_no_model_http'
        assert health['generation']['assets_ready'] is True and health['generation']['model_http_attempts'] == 0
        assert health['generation']['minimum_complete_price_fen'] == 73700
        assert request('/api/v1/demo-access')[1]['mode'] == 'local_demo'
        assert request('/api/v1/demo-access/enter',{'role':'styling-manager'})[0] == 200
        me = request('/api/v1/admin/me')[1]
        assert me['subject'] == 'styling-demo-manager' and me['auth_method'] == 'demo_server'
        assert request('/api/v1/admin/overview')[0] == 200
        assert request('/api/v1/demo-access/enter',{'role':'styling-manager'})[0] == 200
        assert request('/api/v1/admin/me')[1] == me
        manifest = json.loads((clone/'demo_resources/PUBLIC_MANIFEST.json').read_text())
        for look in ['101','112','113','116']:
            status, raw, _ = request('/api/v1/outfits/assets/M1V2-LOOK-'+look)
            assert status == 200 and isinstance(raw,bytes)
            assert hashlib.sha256(raw).hexdigest() == manifest['files']['data/m1_v2/assets/look_'+look+'.png']['sha256']
        assert request('/api/v1/demo-access/enter',{'role':'consumer'})[0] == 200
        profile = request('/api/v1/consumer-profile')[1]
        assert profile['status'] == 'empty'
        mutation = {'profile_action_id':'portable-save','operation':'save','expected_profile_version':0,
            'expected_authorization_context':{k:profile['authorization_context'][k] for k in
                ['context_contract','context_id','operation_token']},
            'patch':{'base_profile':{'usual_sizes':{'shoes':{'system':'cn_shoe','value':'38'}}}},'explicit_save':True}
        assert request('/api/v1/consumer-profile/mutations',mutation)[0] == 200
        saved = request('/api/v1/consumer-profile')[1]
        assert saved['profile_version'] == 1 and saved['base_profile']['usual_sizes']['shoes']['value'] == '38'
        clear = {'profile_action_id':'portable-clear','operation':'clear','expected_profile_version':1,
            'expected_authorization_context':{k:saved['authorization_context'][k] for k in
                ['context_contract','context_id','operation_token']},'patch':{}}
        assert request('/api/v1/consumer-profile/mutations',clear)[0] == 200
        cleared = request('/api/v1/consumer-profile')[1]
        assert cleared['profile_version'] == 2 and cleared['status'] == 'cleared'
        assert cleared['base_profile']['usual_sizes']['shoes'] is None
        assert request('/api/v1/personal-preview/capabilities')[1]['enabled'] is False
        assert not (state/'live-preview').exists()
    finally:
        p.terminate();p.wait(timeout=8)
    p = start(False)
    try:
        assert request('/api/v1/demo-access')[1]['mode'] == 'authenticated'
        assert request('/api/v1/demo-access/enter',{'role':'styling-manager'})[0] == 403
        assert request('/api/v1/admin/me')[0] == 401
        assert request('/api/v1/consumer-profile')[1]['authorization_context']['context_id'] == profile['authorization_context']['context_id']
        assert request('/api/v1/health')[1]['generation']['model_http_attempts'] == 0
    finally:
        p.terminate();p.wait(timeout=8)
    evidence.update(all_passed=True, http_requests=len(evidence['http']), fixed_asset_verified=True,
                    restored_authentication=True, same_consumer_context_after_restart=True,
                    saved_and_cleared_profile_versions=[1,2])
    output = os.getenv('STYLING_TEST_EVIDENCE_DIR')
    if output:
        (Path(output)/'portable-http.json').write_text(json.dumps(evidence,ensure_ascii=False,indent=2)+'\n')
