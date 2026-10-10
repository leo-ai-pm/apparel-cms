"""Real loopback TCP with detached source, new synthetic state, zero model keys."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request


def test_https_deployment_initializes_once_preserves_state_and_https_policy(tmp_path):
    backend = Path(__file__).resolve().parents[1]
    clone = tmp_path/'backend'
    clone.mkdir()
    # Match the deployment freeze: Python app sources, no historical HTML UI.
    # A package marker must carry the empty StaticFiles directory into archives.
    for source in (backend/'app').rglob('*.py'):
        target=clone/source.relative_to(backend)
        target.parent.mkdir(parents=True,exist_ok=True)
        shutil.copyfile(source,target)
    marker=backend/'app/static/.gitkeep'
    if marker.is_file():
        (clone/'app/static').mkdir(parents=True)
        shutil.copyfile(marker,clone/'app/static/.gitkeep')
    for folder, manifest in (('demo_resources', 'PUBLIC_MANIFEST.json'),
                             ('deploy_resources', 'DEPLOY_ASSETS_MANIFEST.json')):
        allowlist=json.loads((backend/folder/manifest).read_text())['files']
        for relative in [manifest, *allowlist]:
            target=clone/folder/relative
            target.parent.mkdir(parents=True,exist_ok=True)
            shutil.copyfile(backend/folder/relative,target)
    assert not (clone/'app/static/index.html').exists()
    (clone/'scripts').mkdir()
    shutil.copyfile(backend/'scripts/start_https_demo.py', clone/'scripts/start_https_demo.py')
    origin = 'https://public-test.example'
    config = tmp_path/'new-secret.json'
    config.write_text(json.dumps({'STYLING_ADMIN_PUBLIC_ORIGIN':origin}))
    config.chmod(0o600)
    pairing=tmp_path/'root-pairing.json'
    pair={k:'synthetic-key-for-'+k+'-20261010-test-only' for k in
          ('session_secret','product_workbench_reader','styling_sender','styling_product_verifier',
           'design_package_reader','design_event_writer','design_asset_reader')}
    pairing.write_text(json.dumps(pair));pairing.chmod(0o600)
    data = tmp_path/'new-state'
    with socket.socket() as reserve:
        reserve.bind(('127.0.0.1', 0)); port = reserve.getsockname()[1]
    command = [sys.executable, str(clone/'scripts/start_https_demo.py'), '--config-file', str(config),
               '--pairing-file',str(pairing),
               '--data-dir', str(data), '--port', str(port)]
    clean = {'PATH':os.getenv('PATH',''), 'LANG':'en_US.UTF-8','PYTHON_DOTENV_DISABLED':'1'}
    init = subprocess.run(command+['--initialize'], env=clean, cwd=clone, capture_output=True, text=True, timeout=20)
    assert init.returncode == 0, 'isolated initialization failed: '+init.stderr
    marker = json.loads(init.stdout)
    assert marker['private_history_imported'] is False and marker['paid_calls_during_initialization'] == 0
    direct=json.loads((data/'direct-auth.json').read_text())
    assert (data/'direct-auth.json').stat().st_mode & 0o077 == 0
    assert direct['targets'][0]['base_url']=='http://127.0.0.1:8191'
    assert direct['verifiers'][0]['subject']=='product-public-verifier'
    assert direct['verifiers'][0]['token_sha256']==hashlib.sha256(pair['styling_product_verifier'].encode()).hexdigest()
    assert hashlib.sha256(direct['targets'][0]['sender_token'].encode()).hexdigest()==hashlib.sha256(pair['styling_sender'].encode()).hexdigest()
    evidence = {'layer':'real_tcp_detached_https_policy_bff_simulation','http':[],
                'starts':0,'stops':0,'paid_calls':0,'old_databases_imported':False,
                'real_tls_or_gateway_verified':False,'linux_dependencies_installed_here':False}
    cookies = {}
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    def request(path, body=None, *, with_origin=True, extra=None):
        headers = {'Content-Type':'application/json', **({'Origin':origin} if with_origin else {})}
        if cookies:
            headers['Cookie'] = '; '.join(k+'='+v for k,v in cookies.items())
        headers.update(extra or {})
        req = urllib.request.Request(f'http://127.0.0.1:{port}'+path,
            data=json.dumps(body).encode() if body is not None else None, headers=headers)
        try:
            response = opener.open(req, timeout=5)
        except urllib.error.HTTPError as e:
            response = e
        with response:
            raw = response.read(); h = response.headers
            for cookie in h.get_all('Set-Cookie', []):
                k,v = cookie.split(';',1)[0].split('=',1);cookies[k]=v
                assert 'Secure' in cookie and 'HttpOnly' in cookie and 'SameSite=strict' in cookie
            value = json.loads(raw) if 'json' in h.get('Content-Type','') else raw
            evidence['http'].append({'path':path,'method':'POST' if body is not None else 'GET','status':response.status})
            return response.status,value,h
    def start():
        process = subprocess.Popen(command,env=clean,cwd=clone,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        evidence['starts'] += 1
        for _ in range(100):
            if process.poll() is not None:
                raise AssertionError('isolated HTTPS policy service did not start')
            try:
                with socket.create_connection(('127.0.0.1',port),timeout=.1):return process
            except OSError:time.sleep(.05)
        process.terminate();process.wait(timeout=5)
        raise AssertionError('isolated deployment listener timeout')
    def stop(process):
        process.terminate();process.wait(timeout=10);evidence['stops']+=1
    process = start()
    try:
        assert (clone/'app/static/.gitkeep').is_file()
        assert (clone/'app/static/.gitkeep').stat().st_size == 0
        evidence['static_directory_from_placeholder']=True
        evidence['legacy_html_ui_included']=False
        evidence['resource_copy_uses_manifest_allowlist']=True
        status,health,_ = request('/api/v1/health')
        assert status==200 and health['generation']['mode']=='offline_controlled_no_model_http'
        assert health['generation']['model_http_attempts']==0
        assert request('/api/v1/demo-access')[1]['mode']=='public_demo'
        assert request('/api/v1/demo-access/enter',{'role':'styling-manager'})[0]==200
        me=request('/api/v1/admin/me')[1]
        assert me['subject']=='styling-public-20261010' and me['scope']=='public-three-agent-20261010'
        assert request('/api/v1/admin/overview')[0]==200
        assert request('/api/v1/demo-access/enter',{'role':'styling-manager'})[0]==200
        assert request('/api/v1/admin/me')[1]==me
        proof='/api/integrations/product-management/v1/verify-approval'
        assert request(proof,{},with_origin=False,extra={'Authorization':'Bearer '+pair['styling_product_verifier']})[0]==403
        saved=dict(cookies);cookies.clear()
        assert request(proof,{},with_origin=False)[0]==401
        assert request(proof,{},with_origin=False,extra={'Authorization':'Bearer '+pair['styling_product_verifier']})[0]==422
        cookies.update(saved)
        assert request('/api/v1/demo-access/enter',{'role':'consumer'})[0]==200
        profile=request('/api/v1/consumer-profile')[1]
        assert profile['status']=='empty'
        body={'profile_action_id':'https-test-save','operation':'save','expected_profile_version':0,
              'expected_authorization_context':{k:profile['authorization_context'][k] for k in
                  ('context_contract','context_id','operation_token')},
              'patch':{'base_profile':{'usual_sizes':{'shoes':{'system':'cn_shoe','value':'38'}}}},
              'explicit_save':True}
        assert request('/api/v1/consumer-profile/mutations',body,with_origin=False)[0]==403
        assert request('/api/v1/consumer-profile/mutations',body,extra={'Origin':'https://evil.example'})[0]==403
        assert request('/api/v1/consumer-profile/mutations',body)[0]==200
        assert request('/api/v1/tryon',{})[1]['error']['code']=='PUBLIC_DEMO_LEGACY_GENERATION_DISABLED'
        for i in range(1,22):
            name=f'P{i:03}.png';status,raw,_=request('/product-images/'+name)
            assert status==200 and hashlib.sha256(raw).hexdigest()==hashlib.sha256((clone/'deploy_resources/source-products'/name).read_bytes()).hexdigest()
        fixed=json.loads((clone/'demo_resources/PUBLIC_MANIFEST.json').read_text())['files']
        for look in (101,112,113,116):
            status,raw,_=request(f'/api/v1/outfits/assets/M1V2-LOOK-{look}')
            assert status==200 and hashlib.sha256(raw).hexdigest()==fixed[f'data/m1_v2/assets/look_{look}.png']['sha256']
        single=json.loads((clone/'deploy_resources/single-products/product-image-manifest-v1.json').read_text())['assets']
        for asset in single:
            status,raw,_=request('/api/v1/outfits/product-assets/'+asset['asset_id'])
            assert status==200 and hashlib.sha256(raw).hexdigest()==asset['image_sha256']
        (data/'private-preview/private-canary.txt').write_text('synthetic-private-canary')
        assert request('/tryon-results/private-canary.txt')[0]==404
        assert request('/private-preview/private-canary.txt')[0]==404
        with sqlite3.connect(data/'fixed-outfits.sqlite3') as db:
            resources_before=db.execute("SELECT value FROM metadata WHERE key='runtime_resources'").fetchone()[0]
        assert json.loads(resources_before)['inventory_snapshot']['valid_until']==marker['inventory_time']['valid_until']
    finally:stop(process)
    before=hashlib.sha256((data/'app.db').read_bytes()).hexdigest()
    duplicate=subprocess.run(command+['--initialize'],env=clean,cwd=clone,capture_output=True,timeout=20)
    assert duplicate.returncode==1 and hashlib.sha256((data/'app.db').read_bytes()).hexdigest()==before
    evidence['second_initialization_refused_without_reset']=True
    process=start()
    try:
        assert request('/api/v1/admin/me')[1]==me
        current=request('/api/v1/consumer-profile')[1]
        assert current['profile_version']==1 and current['base_profile']['usual_sizes']['shoes']['value']=='38'
        assert request('/api/v1/consumer-profile/mutations',body)[0]==200
        with sqlite3.connect(data/'fixed-outfits.sqlite3') as db:
            assert db.execute("SELECT value FROM metadata WHERE key='runtime_resources'").fetchone()[0]==resources_before
        assert request('/api/v1/health')[1]['generation']['model_http_attempts']==0
        evidence['same_context_and_profile_after_restart']=True
        evidence['inventory_and_model_cap_not_reset']=True
    finally:stop(process)
    evidence['http_requests']=len(evidence['http']);evidence['all_passed']=True
    output=os.environ.get('STYLING_HTTPS_TEST_EVIDENCE')
    if output:Path(output).write_text(json.dumps(evidence,ensure_ascii=False,indent=2)+'\n')
