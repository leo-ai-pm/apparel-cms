"""Single-submit real multi-reference adapter. No credential/photo/URL logging."""
from contextlib import contextmanager
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import socket
import sqlite3
import stat
import time
import uuid
from urllib.parse import urlsplit

import httpx

from app.services.personal_preview_provider import ProviderError, ProviderSubmissionUnknown, reference_binding, _ID, _SHA

MODEL = "rhart-image-n-pro-official/edit"
BASE = "https://www.runninghub.cn/openapi/v2"
_STAGES = {'upload_person', 'upload_top', 'upload_bottom', 'upload_shoes', 'generate', 'query', 'download'}
_DIAGNOSTICS = {'UPLOADED', 'PROVIDER_ACK', 'QUERY_RESPONSE', 'DOWNLOADED', 'TRANSPORT_EXCEPTION',
    'HTTP_SERVER_ERROR', 'HTTP_REJECTED', 'INVALID_JSON', 'RESPONSE_TOO_LARGE', 'INVALID_RESPONSE_SCHEMA',
    'MISSING_TASK_ID', 'INVALID_TASK_ID', 'UPLOAD_REJECTED', 'UPLOAD_RESPONSE_INVALID', 'UPLOAD_URL_INVALID',
    'TASK_ID_MISMATCH', 'OUTPUT_INVALID', 'OUTPUT_URL_INVALID', 'OUTPUT_TOO_LARGE', 'DOWNLOAD_HTTP_ERROR'}
_PROVIDER_CODES = {'INVALID_API_KEY', 'UNAUTHORIZED', 'FORBIDDEN', 'INSUFFICIENT_BALANCE', 'INSUFFICIENT_CREDIT',
    'INVALID_PARAMETER', 'INVALID_PARAMS', 'RATE_LIMITED', 'RATE_LIMIT_EXCEEDED', 'QUOTA_EXCEEDED',
    'UPSTREAM_TIMEOUT', 'TASK_FAILED', 'CONTENT_POLICY', 'CONTENT_POLICY_VIOLATION'}
_EXCEPTIONS = {'ReadTimeout', 'ConnectTimeout', 'WriteTimeout', 'PoolTimeout', 'ConnectError', 'ReadError',
    'WriteError', 'RemoteProtocolError', 'LocalProtocolError', 'ProxyError', 'UnsupportedProtocol',
    'TooManyRedirects', 'DecodingError', 'HTTPStatusError', 'HTTPError', 'JSONDecodeError', 'ValueError'}
PROMPT = ("Create ONE photorealistic full-body AI outfit reference. Image 1 is the ONLY person identity "
          "reference: preserve their face, hair, body proportions and apparent identity. Images 2, 3, 4 "
          "are respectively the exact top, bottoms and shoes to wear together. Preserve each garment's "
          "color, silhouette, material and visible details. Show the same person head to shoes wearing "
          "all three items, natural standing pose, simple neutral background. Do not replace the person "
          "with another model. Do not invent accessories or substitute garments. This is an AI visual "
          "reference, not evidence of actual fit or sizing. No collage, text, watermark or duplicate person.")


def configuration_ready():
    return (os.getenv('STYLING_PERSONAL_PREVIEW_REAL_AUTHORIZED') == '1'
            and bool(os.getenv('RUNNINGHUB_API_KEY', '').strip())
            and os.getenv('STYLING_PERSONAL_PREVIEW_REAL_TOTAL_LIMIT') == '1')


def public_usage(path, dispatch_id):
    """Read a safe numeric projection; never return provider IDs or signed URLs."""
    result = {'provider_model': MODEL, 'cost_amount': None, 'cost_currency': None, 'provider_usage': {}}
    path = Path(path)
    try:
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_nlink != 1:
            return result
        with sqlite3.connect(path.as_uri() + '?mode=ro', uri=True) as db:
            row = db.execute('SELECT provider_usage FROM real_dispatches WHERE dispatch_id=?', (dispatch_id,)).fetchone()
        if row and row[0]:
            values = json.loads(row[0])
            result['provider_usage'] = {k: v for k, v in values.items() if isinstance(k, str) and len(k) <= 64
                                        and type(v) in (int, float) and abs(v) < 10**15}
    except (OSError, sqlite3.Error, ValueError, TypeError):
        pass
    return result


class RunningHubProvider:
    mode = 'runninghub'
    is_mock = False

    def __init__(self, path, *, key, client=None, clock=time.time, url_check=None):
        self.path, self.key = Path(path), key
        self.clock, self.url_check = clock, url_check or self._safe_url
        if not key or not self.path.is_absolute() or any(p.is_symlink() for p in (self.path, *self.path.parents)):
            raise ProviderError()
        self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        if self.path.parent.stat().st_mode & 0o077:
            raise ProviderError('PREVIEW_STORAGE_UNAVAILABLE')
        if not self.path.exists():
            fd = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            os.close(fd)
        info = self.path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_nlink != 1:
            raise ProviderError('PREVIEW_STORAGE_UNAVAILABLE')
        # No env proxy; no transport retry; no redirects carrying credentials.
        self.client = client or httpx.Client(timeout=httpx.Timeout(25, connect=10), trust_env=False,
                                             follow_redirects=False)
        with self._db() as db:
            db.execute('CREATE TABLE IF NOT EXISTS real_dispatches(dispatch_id TEXT PRIMARY KEY, snapshot_digest TEXT NOT NULL,'
                       'reference_binding_sha256 TEXT NOT NULL, state TEXT NOT NULL, provider_request_id TEXT,'
                       'created REAL NOT NULL, generation_posts INTEGER NOT NULL DEFAULT 0, query_count INTEGER NOT NULL DEFAULT 0,'
                       'result_url TEXT, provider_usage TEXT)')
            # Additive migration only. Existing dispatch facts/history stay byte-for-byte unchanged.
            db.execute('CREATE TABLE IF NOT EXISTS provider_transport_events('
                'event_id TEXT PRIMARY KEY,dispatch_id TEXT NOT NULL,stage TEXT NOT NULL,method TEXT NOT NULL,'
                'started_at REAL NOT NULL,finished_at REAL,http_status INTEGER,diagnostic_code TEXT,'
                'provider_error_code TEXT,exception_type TEXT,response_bytes INTEGER,response_sha256 TEXT,'
                'response_complete INTEGER,provider_request_id TEXT)')

    @contextmanager
    def _db(self):
        info = self.path.lstat()
        if (not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_nlink != 1
                or any(p.is_symlink() for p in (self.path, *self.path.parents))
                or self.path.parent.stat().st_mode & 0o077):
            raise ProviderError('PREVIEW_STORAGE_UNAVAILABLE')
        db = sqlite3.connect(self.path.as_uri() + '?mode=rw', uri=True, timeout=10)
        db.row_factory = sqlite3.Row
        try:
            db.execute('BEGIN IMMEDIATE')
            yield db
            db.commit()
        except BaseException:
            db.rollback()
            raise
        finally:
            db.close()

    @staticmethod
    def _safe_url(url):
        if not isinstance(url, str) or len(url) > 8192:
            raise ProviderError('PREVIEW_OUTPUT_INVALID')
        p = urlsplit(url)
        host = p.hostname or ''
        if (p.scheme != 'https' or p.username or p.password or p.port not in (None, 443)
                or p.fragment or not any(host == h or host.endswith('.' + h)
                                          for h in ('runninghub.cn', 'runninghub.ai', 'myqcloud.com'))):
            raise ProviderError('PREVIEW_OUTPUT_INVALID')
        try:
            ips = {x[4][0] for x in socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)}
            if not ips or not all(ipaddress.ip_address(x).is_global for x in ips):
                raise ProviderError('PREVIEW_OUTPUT_INVALID')
        except (OSError, ValueError):
            raise ProviderError('PREVIEW_OUTPUT_INVALID') from None
        return url

    def _task_id(self, data):
        value = (data.get('taskId') or data.get('task_id')) if isinstance(data, dict) else None
        return value if (isinstance(value, str) and _ID.fullmatch(value) and self.key not in value) else None

    @staticmethod
    def _provider_code(data):
        if not isinstance(data, dict):
            return None
        value = data.get('errorCode')
        if value in (None, ''):
            value = data.get('code')
        if type(value) is int and -10**9 <= value <= 10**9:
            return str(value)
        if value is None or value == '':
            return None
        # Regex alone would also accept a secret. Only closed known codes survive.
        return value if isinstance(value, str) and value in _PROVIDER_CODES else 'UNRECOGNIZED_PROVIDER_CODE'

    def _begin_event(self, dispatch_id, stage):
        if stage not in _STAGES:
            raise ProviderError('PREVIEW_STORAGE_UNAVAILABLE')
        event_id = 'ppdiag-' + uuid.uuid4().hex
        with self._db() as db:
            if db.execute('SELECT 1 FROM real_dispatches WHERE dispatch_id=?', (dispatch_id,)).fetchone() is None:
                raise ProviderError('PREVIEW_STORAGE_UNAVAILABLE')
            db.execute('INSERT INTO provider_transport_events(event_id,dispatch_id,stage,method,started_at) '
                       'VALUES(?,?,?,?,?)', (event_id, dispatch_id, stage, 'GET' if stage == 'download' else 'POST', self.clock()))
        return event_id

    def _finish_event(self, event_id, code, *, response=None, data=None, error=None, content=None, complete=True):
        if code not in _DIAGNOSTICS:
            raise ProviderError('PREVIEW_STORAGE_UNAVAILABLE')
        exception_type = type(error).__name__ if error is not None else None
        if exception_type is not None and exception_type not in _EXCEPTIONS:
            exception_type = 'HTTPError' if isinstance(error, httpx.HTTPError) else 'ValueError'
        if content is None and response is not None:
            content = response.content
        task_id = self._task_id(data)
        with self._db() as db:
            event = db.execute('SELECT dispatch_id,stage FROM provider_transport_events WHERE event_id=?', (event_id,)).fetchone()
            if event is None:
                raise ProviderError('PREVIEW_STORAGE_UNAVAILABLE')
            db.execute('UPDATE provider_transport_events SET finished_at=?,http_status=?,diagnostic_code=?,'
                'provider_error_code=?,exception_type=?,response_bytes=?,response_sha256=?,response_complete=?,provider_request_id=? '
                'WHERE event_id=? AND finished_at IS NULL',
                (self.clock(), response.status_code if response is not None else None, code, self._provider_code(data), exception_type,
                 len(content) if content is not None else None, hashlib.sha256(content).hexdigest() if content is not None else None,
                 int(complete) if content is not None else None, task_id, event_id))
            # Commit the received original ID with the acknowledgement before any
            # subsequent local step can fail. Never replace a different original ID.
            if task_id and event['stage'] == 'generate':
                row = db.execute('SELECT provider_request_id FROM real_dispatches WHERE dispatch_id=?', (event['dispatch_id'],)).fetchone()
                if row['provider_request_id'] not in (None, task_id):
                    raise ProviderSubmissionUnknown(row['provider_request_id'])
                db.execute('UPDATE real_dispatches SET provider_request_id=? WHERE dispatch_id=?', (task_id, event['dispatch_id']))

    def _json(self, path, *, dispatch_id, stage, **kwargs):
        event_id = self._begin_event(dispatch_id, stage)
        try:
            response = self.client.post(BASE + path, headers={'Authorization': 'Bearer ' + self.key}, **kwargs)
        except httpx.HTTPError as error:
            self._finish_event(event_id, 'TRANSPORT_EXCEPTION', error=error)
            raise ProviderSubmissionUnknown() from None
        data = None
        if len(response.content) <= 256 * 1024:
            try:
                data = response.json()
            except ValueError:
                pass
        if response.status_code >= 500:
            self._finish_event(event_id, 'HTTP_SERVER_ERROR', response=response, data=data)
            raise ProviderSubmissionUnknown(self._task_id(data))
        if response.status_code >= 400:
            self._finish_event(event_id, 'HTTP_REJECTED', response=response, data=data)
            raise ProviderError('PREVIEW_PROVIDER_REJECTED')
        if len(response.content) > 256 * 1024:
            self._finish_event(event_id, 'RESPONSE_TOO_LARGE', response=response)
            raise ProviderSubmissionUnknown()
        try:
            data = response.json()
        except ValueError as error:
            self._finish_event(event_id, 'INVALID_JSON', response=response, error=error)
            raise ProviderSubmissionUnknown() from None
        if not isinstance(data, dict):
            self._finish_event(event_id, 'INVALID_RESPONSE_SCHEMA', response=response)
            raise ProviderSubmissionUnknown()
        return data, event_id, response

    def submit(self, dispatch_id, snapshot, input_bytes, references=None):
        if (not isinstance(dispatch_id, str) or not _ID.fullmatch(dispatch_id)
                or not isinstance(snapshot, dict) or not _SHA.fullmatch(snapshot.get('snapshot_digest', ''))
                or not isinstance(input_bytes, bytes) or not 0 < len(input_bytes) <= 5*1024*1024):
            raise ProviderError()
        binding = reference_binding(references)
        with self._db() as db:
            old = db.execute('SELECT * FROM real_dispatches WHERE dispatch_id=?', (dispatch_id,)).fetchone()
            if old:
                raise ProviderSubmissionUnknown(old['provider_request_id'])
            if db.execute('SELECT count(*) FROM real_dispatches').fetchone()[0] >= 1:
                raise ProviderError('PREVIEW_TOTAL_LIMIT')
            db.execute('INSERT INTO real_dispatches(dispatch_id,snapshot_digest,reference_binding_sha256,state,created) '
                       'VALUES(?,?,?,?,?)', (dispatch_id, snapshot['snapshot_digest'], binding, 'uploading', self.clock()))
        try:
            images = [input_bytes] + [next(x['data'] for x in references if x['slot'] == slot)
                                     for slot in ('top', 'bottom', 'shoes')]
            urls = []
            for i, image in enumerate(images):
                data, event_id, response = self._json('/media/upload/binary', dispatch_id=dispatch_id,
                    stage=('upload_person', 'upload_top', 'upload_bottom', 'upload_shoes')[i],
                    files={'file': (f'reference-{i}.jpg', image, 'image/jpeg')})
                if data.get('code') != 0:
                    self._finish_event(event_id, 'UPLOAD_REJECTED', response=response, data=data)
                    raise ProviderError('PREVIEW_UPLOAD_FAILED')
                raw = data.get('data')
                if not isinstance(raw, dict) or not isinstance(raw.get('download_url'), str):
                    self._finish_event(event_id, 'UPLOAD_RESPONSE_INVALID', response=response, data=data)
                    raise ProviderError('PREVIEW_UPLOAD_FAILED')
                try:
                    urls.append(self.url_check(raw['download_url']))
                except (ProviderError, ValueError):
                    self._finish_event(event_id, 'UPLOAD_URL_INVALID', response=response, data=data)
                    raise ProviderError('PREVIEW_UPLOAD_FAILED') from None
                self._finish_event(event_id, 'UPLOADED', response=response, data=data)
        except (httpx.HTTPError, ValueError, ProviderError):
            with self._db() as db:
                db.execute("UPDATE real_dispatches SET state='upload_failed' WHERE dispatch_id=?", (dispatch_id,))
            raise ProviderError('PREVIEW_UPLOAD_FAILED') from None
        # Durable fact BEFORE the only billable POST; no retry after any ambiguity.
        with self._db() as db:
            db.execute("UPDATE real_dispatches SET state='dispatching',generation_posts=1 WHERE dispatch_id=?", (dispatch_id,))
        try:
            data, event_id, response = self._json('/' + MODEL, dispatch_id=dispatch_id, stage='generate',
                                               json={'imageUrls': urls, 'prompt': PROMPT,
                                                'resolution': '1k', 'aspectRatio': '3:4'})
            task_id = self._task_id(data)
            if task_id is None:
                self._finish_event(event_id, 'MISSING_TASK_ID' if not (data.get('taskId') or data.get('task_id'))
                                   else 'INVALID_TASK_ID', response=response, data=data)
                raise ProviderSubmissionUnknown()
            self._finish_event(event_id, 'PROVIDER_ACK', response=response, data=data)
            with self._db() as db:
                db.execute("UPDATE real_dispatches SET state='running',provider_request_id=? WHERE dispatch_id=?",
                           (task_id, dispatch_id))
            return self._base_outcome(dispatch_id, 'running')
        except ProviderSubmissionUnknown as error:
            raise ProviderSubmissionUnknown(error.provider_request_id) from None
        except (httpx.HTTPError, ValueError):
            raise ProviderSubmissionUnknown() from None
        except ProviderError:
            with self._db() as db:
                db.execute("UPDATE real_dispatches SET state='rejected' WHERE dispatch_id=?", (dispatch_id,))
            raise

    def _row(self, dispatch_id):
        with self._db() as db:
            row = db.execute('SELECT * FROM real_dispatches WHERE dispatch_id=?', (dispatch_id,)).fetchone()
        if not row:
            raise ProviderSubmissionUnknown()
        return dict(row)

    def _base_outcome(self, dispatch_id, status):
        row = self._row(dispatch_id)
        return {'status': status, 'provider_request_id': row['provider_request_id'],
                'snapshot_digest': row['snapshot_digest'], 'reference_binding_sha256': row['reference_binding_sha256'],
                'reference_count': 3, 'is_mock': False, 'semantic_verified': False,
                'effect_kind': 'ai_personal_reference', 'provider_model': MODEL, 'cost_status': 'unknown',
                'cost_amount': None, 'cost_currency': None,
                'provider_usage': json.loads(row['provider_usage']) if row['provider_usage'] else {}}

    def query(self, dispatch_id, provider_request_id=None):
        row = self._row(dispatch_id)
        task_id = row['provider_request_id']
        if not task_id or (provider_request_id is not None and provider_request_id != task_id):
            raise ProviderSubmissionUnknown(provider_request_id)
        if self.clock() - row['created'] > 1800:
            raise ProviderSubmissionUnknown(task_id)
        try:
            with self._db() as db:
                db.execute('UPDATE real_dispatches SET query_count=query_count+1 WHERE dispatch_id=?', (dispatch_id,))
            data, event_id, response = self._json('/query', dispatch_id=dispatch_id, stage='query', json={'taskId': task_id})
            # A task ID mismatch is never rebound to a new external task.
            if data.get('taskId', task_id) != task_id:
                self._finish_event(event_id, 'TASK_ID_MISMATCH', response=response, data=data)
                raise ProviderSubmissionUnknown(task_id)
            status = data.get('status')
            if status in ('CREATE', 'QUEUED', 'RUNNING'):
                self._finish_event(event_id, 'QUERY_RESPONSE', response=response, data=data)
                return self._base_outcome(dispatch_id, 'running')
            if status in ('FAILED', 'CANCEL'):
                self._finish_event(event_id, 'QUERY_RESPONSE', response=response, data=data)
                return {**self._base_outcome(dispatch_id, 'failed'), 'error_code': 'PREVIEW_PROVIDER_FAILED'}
            if status != 'SUCCESS':
                self._finish_event(event_id, 'INVALID_RESPONSE_SCHEMA', response=response, data=data)
                raise ProviderSubmissionUnknown(task_id)
            outputs = data.get('results')
            if not isinstance(outputs, list) or len(outputs) != 1 or not isinstance(outputs[0], dict):
                self._finish_event(event_id, 'OUTPUT_INVALID', response=response, data=data)
                raise ProviderError('PREVIEW_OUTPUT_INVALID')
            try:
                url = self.url_check(outputs[0].get('url') or outputs[0].get('outputUrl'))
            except (ProviderError, ValueError):
                self._finish_event(event_id, 'OUTPUT_URL_INVALID', response=response, data=data)
                raise ProviderError('PREVIEW_OUTPUT_INVALID') from None
            self._finish_event(event_id, 'QUERY_RESPONSE', response=response, data=data)
            usage = data.get('usage')
            usage = {k: v for k, v in usage.items() if isinstance(k, str) and len(k) <= 64
                     and type(v) in (int, float) and abs(v) < 10**15} if isinstance(usage, dict) else {}
            with self._db() as db:
                # Do not persist new signed URLs. Recovery queries the same task,
                # while the old column/rows remain intact for compatibility.
                db.execute('UPDATE real_dispatches SET provider_usage=? WHERE dispatch_id=?',
                           (json.dumps(usage, allow_nan=False), dispatch_id))
            output = self._download(dispatch_id, task_id, url)
            return {**self._base_outcome(dispatch_id, 'output_pending_review'), 'data': output}
        except (httpx.HTTPError, ValueError, ProviderSubmissionUnknown):
            raise ProviderSubmissionUnknown(task_id) from None

    def _download(self, dispatch_id, task_id, url):
        event_id = self._begin_event(dispatch_id, 'download')
        output, response = bytearray(), None
        # Signed URL stays private; credential is never forwarded to image host.
        try:
            with self.client.stream('GET', url, headers={}) as response:
                if response.status_code != 200:
                    self._finish_event(event_id, 'DOWNLOAD_HTTP_ERROR', response=response, content=b'', complete=False)
                    raise ProviderSubmissionUnknown(task_id)
                for chunk in response.iter_bytes():
                    output.extend(chunk)
                    if len(output) > 5*1024*1024:
                        self._finish_event(event_id, 'OUTPUT_TOO_LARGE', response=response, content=bytes(output), complete=False)
                        raise ProviderError('PREVIEW_OUTPUT_INVALID')
            self._finish_event(event_id, 'DOWNLOADED', response=response, content=bytes(output))
            return bytes(output)
        except httpx.HTTPError as error:
            self._finish_event(event_id, 'TRANSPORT_EXCEPTION', response=response, content=bytes(output) if response is not None else None,
                               complete=False, error=error)
            raise ProviderSubmissionUnknown(task_id) from None
