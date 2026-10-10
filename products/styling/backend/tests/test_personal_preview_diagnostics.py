"""No network: diagnose the actual provider boundary without replaying live input."""
import hashlib
import json
import sqlite3

import httpx
import pytest

from app.services.personal_preview_provider import ProviderError, ProviderSubmissionUnknown
from app.services.personal_preview_runninghub import RunningHubProvider
from tests.test_personal_preview_runninghub import inputs

SECRET = 'synthetic-do-not-store-key-cookie-or-message'
PRIVATE_URL = 'https://images.runninghub.cn/input?signed=synthetic-private-signature'


def provider(tmp_path, branch='success', target='generate'):
    path = tmp_path/'private'; path.mkdir(mode=0o700)
    calls = []
    def handler(request):
        calls.append(request.url.path)
        stage = 'upload' if request.url.path.endswith('/binary') else ('query' if request.url.path.endswith('/query') else 'generate')
        if stage == target:
            if branch == 'timeout': raise httpx.ReadTimeout(SECRET, request=request)
            if branch == 'connect-error': raise httpx.ConnectError(SECRET, request=request)
            if branch == 'invalid-json': return httpx.Response(200,content=SECRET.encode())
            if branch == 'oversize': return httpx.Response(200,content=b'x'*(256*1024+1))
            if branch == 'missing-id': return httpx.Response(200,json={'status':'RUNNING','message':SECRET})
            if branch == 'numeric-id': return httpx.Response(200,json={'taskId':123})
            if branch == '500': return httpx.Response(503,json={'errorCode':'UPSTREAM_TIMEOUT','message':SECRET})
            if branch == '401': return httpx.Response(401,json={'errorCode':'INVALID_API_KEY','message':SECRET})
            if branch == '429': return httpx.Response(429,json={'code':429,'message':SECRET})
            if branch == 'unknown-code': return httpx.Response(500,json={'errorCode':SECRET,'message':PRIVATE_URL})
            if branch == 'upload-code': return httpx.Response(200,json={'code':-123,'message':SECRET})
            if branch == 'upload-no-url': return httpx.Response(200,json={'code':0,'data':{},'message':SECRET})
            if branch == 'taskid-on-500': return httpx.Response(503,json={'taskId':'original-task','errorCode':'UPSTREAM_TIMEOUT','message':SECRET})
        if stage == 'upload':return httpx.Response(200,json={'code':0,'data':{'download_url':PRIVATE_URL}})
        if stage == 'query':return httpx.Response(200,json={'taskId':'original-task','status':'RUNNING'})
        return httpx.Response(200,json={'taskId':'original-task','status':'RUNNING','message':SECRET})
    client = httpx.Client(transport=httpx.MockTransport(handler),trust_env=False)
    p = RunningHubProvider(path/'runninghub.sqlite3',key=SECRET,client=client,url_check=lambda u:u)
    return p,calls


def events(p):
    with sqlite3.connect(p.path) as db:
        db.row_factory=sqlite3.Row
        assert 'provider_transport_events' in {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        return [dict(r) for r in db.execute('SELECT * FROM provider_transport_events ORDER BY started_at,event_id')]


@pytest.mark.parametrize('branch,diagnostic', [('timeout','TRANSPORT_EXCEPTION'),('connect-error','TRANSPORT_EXCEPTION'),
    ('500','HTTP_SERVER_ERROR'),('401','HTTP_REJECTED'),('429','HTTP_REJECTED'),('invalid-json','INVALID_JSON'),
    ('oversize','RESPONSE_TOO_LARGE'),('missing-id','MISSING_TASK_ID'),('numeric-id','INVALID_TASK_ID'),
    ('unknown-code','HTTP_SERVER_ERROR')])
def test_generation_branch_records_safe_diagnostics_and_never_reposts(tmp_path, branch, diagnostic):
    p,calls=provider(tmp_path,branch)
    with pytest.raises(ProviderError):p.submit('dispatch1',*inputs())
    rows=events(p)
    assert [r['stage'] for r in rows]==['upload_person','upload_top','upload_bottom','upload_shoes','generate']
    final=rows[-1]
    assert final['diagnostic_code']==diagnostic and final['finished_at'] is not None
    if branch in ('timeout','connect-error'):
        assert final['http_status'] is None and final['response_bytes'] is None
        assert final['exception_type'] in ('ReadTimeout','ConnectError')
    else:
        assert final['http_status'] is not None and final['response_bytes']>0 and len(final['response_sha256'])==64
    serialized=json.dumps(rows)
    assert SECRET not in serialized and PRIVATE_URL not in serialized and 'signed=' not in serialized
    with pytest.raises(ProviderSubmissionUnknown):p.submit('dispatch1',*inputs())
    with pytest.raises(ProviderSubmissionUnknown):p.query('dispatch1')
    assert len(calls)==5 and len(events(p))==5


def test_success_ack_records_four_uploads_and_taskid_privately(tmp_path):
    p,calls=provider(tmp_path)
    p.submit('dispatch1',*inputs())
    rows=events(p)
    assert len(rows)==5 and all(r['method']=='POST' for r in rows)
    assert all(r['diagnostic_code']=='UPLOADED' for r in rows[:4])
    assert rows[-1]['diagnostic_code']=='PROVIDER_ACK' and rows[-1]['provider_request_id']=='original-task'
    assert p.query('dispatch1')['status']=='running'
    assert events(p)[-1]['stage']=='query'
    assert SECRET not in json.dumps(events(p)) and PRIVATE_URL not in json.dumps(events(p))


@pytest.mark.parametrize('branch', ['timeout','500','upload-code','upload-no-url','invalid-json','oversize'])
def test_upload_fault_is_recorded_before_generation_and_not_retried(tmp_path,branch):
    p,calls=provider(tmp_path,branch,target='upload')
    with pytest.raises(ProviderError):p.submit('dispatch1',*inputs())
    rows=events(p)
    assert len(rows)==1 and rows[0]['stage']=='upload_person' and rows[0]['finished_at'] is not None
    with sqlite3.connect(p.path) as db:
        assert db.execute('SELECT generation_posts FROM real_dispatches').fetchone()[0]==0
    with pytest.raises(ProviderSubmissionUnknown):p.submit('dispatch1',*inputs())
    assert len(calls)==1


def test_unrecognized_error_code_does_not_store_arbitrary_text(tmp_path):
    p,_=provider(tmp_path,'unknown-code')
    with pytest.raises(ProviderError):p.submit('dispatch1',*inputs())
    assert events(p)[-1]['provider_error_code']=='UNRECOGNIZED_PROVIDER_CODE'


def test_taskid_on_ambiguous_http_is_saved_for_query_only(tmp_path):
    p,calls=provider(tmp_path,'taskid-on-500')
    with pytest.raises(ProviderSubmissionUnknown) as error:p.submit('dispatch1',*inputs())
    assert error.value.provider_request_id=='original-task'
    with sqlite3.connect(p.path) as db:
        assert db.execute('SELECT provider_request_id FROM real_dispatches').fetchone()[0]=='original-task'
    assert p.query('dispatch1')['provider_request_id']=='original-task'
    assert len(calls)==6 and len(events(p))==6


def test_existing_unknown_ledger_upgrade_does_not_backfill_history(tmp_path):
    path=tmp_path/'private';path.mkdir(mode=0o700);file=path/'runninghub.sqlite3'
    with sqlite3.connect(file) as db:
        db.execute('CREATE TABLE real_dispatches(dispatch_id TEXT PRIMARY KEY, snapshot_digest TEXT NOT NULL,'
            'reference_binding_sha256 TEXT NOT NULL,state TEXT NOT NULL,provider_request_id TEXT,created REAL NOT NULL,'
            'generation_posts INTEGER NOT NULL DEFAULT 0,query_count INTEGER NOT NULL DEFAULT 0,result_url TEXT,provider_usage TEXT)')
        db.execute('INSERT INTO real_dispatches VALUES(?,?,?,?,?,?,?,?,?,?)',('original-dispatch','a'*64,'b'*64,'dispatching',None,123,1,0,None,None))
    file.chmod(0o600)
    with sqlite3.connect(file) as db:before=db.execute('SELECT * FROM real_dispatches').fetchall()
    calls=[]
    p=RunningHubProvider(file,key=SECRET,client=httpx.Client(transport=httpx.MockTransport(lambda r:calls.append(r))))
    assert events(p)==[]
    with pytest.raises(ProviderSubmissionUnknown):p.query('original-dispatch')
    with pytest.raises(ProviderSubmissionUnknown):p.submit('original-dispatch',*inputs())
    with sqlite3.connect(file) as db:assert db.execute('SELECT * FROM real_dispatches').fetchall()==before
    assert calls==[] and events(p)==[]


def test_missing_diagnostic_persistence_prevents_any_http(tmp_path,monkeypatch):
    p,calls=provider(tmp_path)
    def unavailable(*args,**kwargs):raise ProviderError('PREVIEW_STORAGE_UNAVAILABLE')
    monkeypatch.setattr(p,'_begin_event',unavailable)
    with pytest.raises(ProviderError):p.submit('dispatch1',*inputs())
    assert calls==[]


@pytest.mark.parametrize('position', [1,2,3,4])
def test_every_upload_stage_is_counted_even_when_it_times_out(tmp_path,position):
    p,calls=provider(tmp_path)
    original=p.client._transport.handler
    def handler(request):
        if request.url.path.endswith('/binary') and len(calls)==position-1:
            calls.append(request.url.path)
            raise httpx.ReadTimeout(SECRET,request=request)
        return original(request)
    p.client._transport.handler=handler
    with pytest.raises(ProviderError):p.submit('dispatch1',*inputs())
    rows=events(p)
    assert len(rows)==position and rows[-1]['stage']==['upload_person','upload_top','upload_bottom','upload_shoes'][position-1]
    assert rows[-1]['exception_type']=='ReadTimeout'
    assert all(r['diagnostic_code']=='UPLOADED' for r in rows[:-1])
    assert not any('/edit' in c for c in calls)


@pytest.mark.parametrize('branch', ['timeout','500','invalid-json','oversize'])
def test_query_failure_retains_original_id_and_cannot_resubmit(tmp_path,branch):
    p,calls=provider(tmp_path,branch,target='query')
    p.submit('dispatch1',*inputs())
    with pytest.raises(ProviderSubmissionUnknown) as error:p.query('dispatch1')
    assert error.value.provider_request_id=='original-task'
    assert len(events(p))==6 and events(p)[-1]['stage']=='query'
    assert events(p)[-1]['diagnostic_code']!='QUERY_RESPONSE'
    with pytest.raises(ProviderSubmissionUnknown):p.submit('dispatch1',*inputs())
    assert len(calls)==6


@pytest.mark.parametrize('mode,diagnostic', [('mismatch','TASK_ID_MISMATCH'),('bad-status','INVALID_RESPONSE_SCHEMA'),
    ('no-output','OUTPUT_INVALID'),('bad-url','OUTPUT_URL_INVALID')])
def test_query_semantic_failure_records_safe_category(tmp_path,mode,diagnostic):
    p,calls=provider(tmp_path)
    original=p.client._transport.handler
    def handler(request):
        if request.url.path.endswith('/query'):
            calls.append(request.url.path)
            data={'taskId':'original-task','status':'SUCCESS','results':[{'url':PRIVATE_URL}],'message':SECRET}
            if mode=='mismatch':data['taskId']='another-task'
            if mode=='bad-status':data['status']='unsupported'
            if mode=='no-output':data['results']=[]
            return httpx.Response(200,json=data)
        return original(request)
    p.client._transport.handler=handler
    p.submit('dispatch1',*inputs())
    if mode=='bad-url':
        p.url_check=lambda u: (_ for _ in ()).throw(ProviderError())
    with pytest.raises(ProviderError):p.query('dispatch1')
    assert events(p)[-1]['diagnostic_code']==diagnostic
    assert len(calls)==6 and PRIVATE_URL not in json.dumps(events(p))
    with sqlite3.connect(p.path) as db:assert db.execute('SELECT provider_request_id FROM real_dispatches').fetchone()[0]=='original-task'


@pytest.mark.parametrize('mode,diagnostic', [('success','DOWNLOADED'),('http','DOWNLOAD_HTTP_ERROR'),
    ('timeout','TRANSPORT_EXCEPTION'),('oversize','OUTPUT_TOO_LARGE')])
def test_download_diagnostics_never_contain_signed_url(tmp_path,mode,diagnostic):
    from tests.test_personal_preview_core import synthetic_photo
    p,calls=provider(tmp_path)
    original=p.client._transport.handler
    def handler(request):
        if request.url.path.endswith('/query'):
            calls.append(request.url.path)
            return httpx.Response(200,json={'taskId':'original-task','status':'SUCCESS','results':[{'url':PRIVATE_URL}]})
        if request.method=='GET':
            calls.append('private-image-get')
            assert 'authorization' not in request.headers
            if mode=='http':return httpx.Response(503,content=SECRET.encode())
            if mode=='timeout':raise httpx.ReadTimeout(SECRET,request=request)
            return httpx.Response(200,content=synthetic_photo() if mode=='success' else b'x'*(5*1024*1024+1))
        return original(request)
    p.client._transport.handler=handler
    p.submit('dispatch1',*inputs())
    if mode=='success':assert p.query('dispatch1')['status']=='output_pending_review'
    else:
        with pytest.raises(ProviderError):p.query('dispatch1')
    rows=events(p)
    assert len(rows)==7 and rows[-1]['stage']=='download' and rows[-1]['diagnostic_code']==diagnostic
    assert PRIVATE_URL not in json.dumps(rows) and SECRET not in json.dumps(rows)
    assert len(calls)==7 and calls.count('/openapi/v2/rhart-image-n-pro-official/edit')==1
    with sqlite3.connect(p.path) as db:
        assert db.execute('SELECT result_url FROM real_dispatches').fetchone()[0] is None


def test_secret_disguised_as_provider_task_id_is_not_persisted(tmp_path):
    p,calls=provider(tmp_path)
    original=p.client._transport.handler
    def handler(request):
        if request.url.path.endswith('/edit'):
            calls.append(request.url.path)
            return httpx.Response(200,json={'taskId':SECRET,'message':SECRET})
        return original(request)
    p.client._transport.handler=handler
    with pytest.raises(ProviderSubmissionUnknown):p.submit('dispatch1',*inputs())
    assert events(p)[-1]['diagnostic_code']=='INVALID_TASK_ID'
    assert SECRET not in json.dumps(events(p))


def test_symlink_and_permissions_block_diagnostic_storage(tmp_path):
    directory=tmp_path/'insecure';directory.mkdir(mode=0o755)
    with pytest.raises(ProviderError):RunningHubProvider(directory/'ledger.sqlite3',key=SECRET)
    private=tmp_path/'private';private.mkdir(mode=0o700)
    other=tmp_path/'other';other.write_text('foreign');other.chmod(0o600)
    link=private/'ledger.sqlite3';link.symlink_to(other)
    with pytest.raises(ProviderError):RunningHubProvider(link,key=SECRET)


def test_diagnostic_write_failure_after_submit_ack_cannot_cause_another_post(tmp_path,monkeypatch):
    p,calls=provider(tmp_path)
    original=p._finish_event
    def fail_once(event_id,code,**kwargs):
        if code=='PROVIDER_ACK':raise sqlite3.OperationalError('synthetic storage failure')
        return original(event_id,code,**kwargs)
    monkeypatch.setattr(p,'_finish_event',fail_once)
    with pytest.raises(sqlite3.OperationalError):p.submit('dispatch1',*inputs())
    with pytest.raises(ProviderSubmissionUnknown):p.submit('dispatch1',*inputs())
    with pytest.raises(ProviderSubmissionUnknown):p.query('dispatch1')
    assert len(calls)==5
    assert events(p)[-1]['stage']=='generate' and events(p)[-1]['finished_at'] is None


def test_diagnostic_storage_permission_change_is_revalidated_before_http(tmp_path):
    p,calls=provider(tmp_path)
    p.path.parent.chmod(0o755)
    with pytest.raises(ProviderError):p.submit('dispatch1',*inputs())
    assert calls==[]
