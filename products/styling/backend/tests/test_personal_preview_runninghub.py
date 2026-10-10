import hashlib
import json
import os
import sqlite3

import httpx
import pytest

from app.services.personal_preview_provider import ProviderError, ProviderSubmissionUnknown
from app.services.personal_preview_runninghub import RunningHubProvider, MODEL
from tests.test_personal_preview_core import preview_env, synthetic_photo, confirmation


def inputs():
    refs = []
    for slot, color in [('shoes', 'blue'), ('bottom', 'green'), ('top', 'red')]:
        data = synthetic_photo(color)
        refs.append(dict(slot=slot, data=data, reference_sha256=hashlib.sha256(data).hexdigest(),
                         sku_id='sku-'+slot, product_id='product-'+slot, reference_asset_id='ref-'+slot,
                         reference_version=1))
    return {'snapshot_digest': 'a'*64}, synthetic_photo(), refs


def setup(tmp_path, mode='success'):
    private = tmp_path / 'provider'
    private.mkdir(mode=0o700)
    calls = []
    output = synthetic_photo('orange')

    def handler(request):
        calls.append((request.method, request.url.path, request.content, dict(request.headers)))
        if request.url.path.endswith('/binary'):
            return httpx.Response(200, json={'code': 0, 'data': {'download_url': 'https://images.runninghub.cn/input-'+str(len(calls))}})
        if request.url.path.endswith('/edit'):
            if mode == 'timeout':
                raise httpx.ReadTimeout('synthetic', request=request)
            if mode == 'no-id':
                return httpx.Response(200, json={'status': 'RUNNING'})
            return httpx.Response(200, json={'taskId': 'task-1', 'status': 'RUNNING'})
        if request.url.path.endswith('/query'):
            return httpx.Response(200, json={'taskId': 'task-1', 'status': 'SUCCESS',
                  'results': [{'url': 'https://images.runninghub.cn/result'}],
                  'usage': {'tokens': 123, 'signed_url': 'must-not-leak'}})
        return httpx.Response(200, content=output)

    client = httpx.Client(transport=httpx.MockTransport(handler), trust_env=False)
    provider = RunningHubProvider(private/'ledger.sqlite3', key='synthetic-secret', client=client,
                                  url_check=lambda url: url)
    return provider, calls, client


def test_four_inputs_exact_order_once_submit_query_and_private_result(tmp_path):
    p, calls, client = setup(tmp_path)
    snapshot, photo, refs = inputs()
    result = p.submit('dispatch1', snapshot, photo, refs)
    assert result['status'] == 'running' and result['is_mock'] is False
    assert len(calls) == 5
    for i, data in enumerate([photo] + [next(r['data'] for r in refs if r['slot'] == s) for s in ('top','bottom','shoes')]):
        assert data in calls[i][2]
    payload = json.loads(calls[4][2])
    assert len(payload['imageUrls']) == 4 and payload['resolution'] == '1k'
    assert payload['aspectRatio'] == '3:4' and 'ONLY person identity' in payload['prompt']
    with pytest.raises(ProviderSubmissionUnknown):
        p.submit('dispatch1', snapshot, photo, refs)
    assert len(calls) == 5
    output = p.query('dispatch1', 'task-1')
    assert output['status'] == 'output_pending_review' and not output['semantic_verified']
    assert output['provider_model'] == MODEL and output['cost_amount'] is None
    assert output['provider_usage'] == {'tokens': 123}
    assert len(calls) == 7 and 'authorization' not in calls[-1][3]
    # Same durable provider after restart knows original task, never submits anew.
    reopened = RunningHubProvider(p.path, key='synthetic-secret', client=client, url_check=lambda u:u)
    assert reopened.query('dispatch1')['provider_request_id'] == 'task-1'
    assert sum(path.endswith('/edit') for _,path,_,_ in calls) == 1
    with pytest.raises(ProviderError) as error:
        reopened.submit('dispatch2', snapshot, photo, refs)
    assert error.value.code == 'PREVIEW_TOTAL_LIMIT'


@pytest.mark.parametrize('mode', ['timeout','no-id'])
def test_ambiguous_submit_without_taskid_never_uploads_or_posts_again(tmp_path, mode):
    p, calls, _ = setup(tmp_path, mode)
    with pytest.raises(ProviderSubmissionUnknown):
        p.submit('dispatch1', *inputs())
    with pytest.raises(ProviderSubmissionUnknown):
        p.query('dispatch1')
    with pytest.raises(ProviderSubmissionUnknown):
        p.submit('dispatch1', *inputs())
    assert len(calls) == 5
    with sqlite3.connect(p.path) as db:
        assert db.execute('SELECT generation_posts,provider_request_id FROM real_dispatches').fetchone() == (1,None)


@pytest.mark.parametrize('url', ['http://127.0.0.1/a','https://127.0.0.1/a','https://evil.example/a',
                               'https://runninghub.cn.evil.example/a','https://u:p@runninghub.cn/a',
                               'https://runninghub.cn:8000/a'])
def test_provider_url_is_not_arbitrary_fetch(url):
    with pytest.raises(ProviderError):
        RunningHubProvider._safe_url(url)


def test_provider_url_resolving_private_address_is_rejected(monkeypatch):
    monkeypatch.setattr('socket.getaddrinfo', lambda *a, **kw: [(None,None,None,None,('127.0.0.1',443))])
    with pytest.raises(ProviderError):
        RunningHubProvider._safe_url('https://images.runninghub.cn/a')


def test_changed_reference_rejected_before_any_upload(tmp_path):
    p, calls, _ = setup(tmp_path)
    snapshot, photo, refs = inputs()
    refs[0]['data'] = b'changed'
    with pytest.raises(ProviderError):
        p.submit('dispatch1',snapshot,photo,refs)
    assert calls == []


def test_real_store_global_budget_and_unreviewed_dto(preview_env, monkeypatch):
    ctx = preview_env
    monkeypatch.setenv('STYLING_PERSONAL_PREVIEW_REAL_AUTHORIZED','1')
    monkeypatch.setenv('STYLING_PERSONAL_PREVIEW_REAL_TOTAL_LIMIT','1')
    monkeypatch.setenv('RUNNINGHUB_API_KEY','synthetic')
    ctx['store'].provider_mode = 'runninghub'
    metadata, photo = confirmation(ctx)
    original = ctx['store'].submit(ctx['owner'],ctx['auth'],metadata,photo)
    assert not original['task']['is_mock'] and original['task']['effect_kind'] == 'unavailable'
    job = ctx['store'].claim_next('worker')
    assert ctx['store'].finish(job, dict(status='output_pending_review',snapshot_digest=job['snapshot']['snapshot_digest'],
                                       data=synthetic_photo(),is_mock=False,semantic_verified=False))
    dto = ctx['store'].lookup_request(ctx['owner'],ctx['auth'],metadata['request_id'])
    assert dto['effect_kind'] == 'ai_personal_reference' and dto['effective_personal_preview'] is False
    # Original idempotent replay survives exhausted budget.
    assert ctx['store'].submit(ctx['owner'],ctx['auth'],metadata,photo)['duplicate'] is True
    second, photo = confirmation(ctx)
    with pytest.raises(Exception) as error:
        ctx['store'].submit(ctx['owner'],ctx['auth'],second,photo)
    assert error.value.code == 'PREVIEW_TOTAL_LIMIT'
    # Clearing 90-day snapshot metadata cannot renew the authorized budget.
    with ctx['store'].db:
        ctx['store'].db.execute("UPDATE preview_tasks SET snapshot=''")
    with pytest.raises(Exception) as error:
        ctx['store'].submit(ctx['owner'],ctx['auth'],second,photo)
    assert error.value.code == 'PREVIEW_TOTAL_LIMIT'


def test_real_worker_keeps_event_loop_responsive_and_drains_on_cancel(monkeypatch):
    import asyncio
    import threading
    from app.services import personal_preview_worker as worker
    started, finish = threading.Event(), threading.Event()
    provider = type('Provider', (), {'mode':'runninghub'})()
    store = type('Store', (), {'cleanup':lambda self: None})()
    monkeypatch.setattr(worker, 'get_provider', lambda: provider)
    def bounded(*args):
        started.set()
        assert finish.wait(timeout=2)
        return True
    monkeypatch.setattr(worker, 'run_once', bounded)
    async def verify():
        task = asyncio.create_task(worker.poll(store))
        for _ in range(100):
            if started.is_set(): break
            await asyncio.sleep(.002)
        assert started.is_set()
        task.cancel()
        await asyncio.sleep(.01)
        assert not task.done()  # worker thread is drained, not abandoned
        finish.set()
        with pytest.raises(asyncio.CancelledError):
            await task
    asyncio.run(verify())
