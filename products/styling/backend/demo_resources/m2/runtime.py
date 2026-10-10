"""Small preview-runtime controls; no credentials or user text in diagnostics."""
import base64
from dataclasses import dataclass
import hashlib
import hmac
from http.cookies import SimpleCookie
import json
import re
import secrets
import threading
import time
from urllib.parse import urlsplit

from .core import Fault, require


def redact_text(value):
    value=re.sub(r'(?i)\b(?:sk|sk-proj)-[a-z0-9_-]{12,}', '[密钥已隐藏]', value)
    value=re.sub(r'(?i)(?:bearer\s+)[a-z0-9_.-]{12,}', '[凭据已隐藏]', value)
    value=re.sub(r'[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}', '[邮箱已隐藏]', value)
    value=re.sub(r'(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)', '[手机号已隐藏]', value)
    return value[:3000]


class RequestLimits:
    def __init__(self, per_minute=0, daily_calls=0, model_concurrency=0):
        self.per_minute=per_minute;self.daily_calls=daily_calls
        self.windows={};self.day=None;self.daily_count=0;self.lock=threading.Lock()
        self.store=None
        self.semaphore=threading.BoundedSemaphore(model_concurrency) if model_concurrency else None

    def check(self,identity,at,model_call=True):
        with self.lock:
            minute=int(at//60);day=int(at//86400)
            if self.day!=day:self.day=day;self.daily_count=0
            self.windows={key:entry for key,entry in self.windows.items() if entry[0]>=minute}
            entry=self.windows.get(identity,(minute,0))
            require(not self.per_minute or entry[1]<self.per_minute,'RATE_LIMITED','请求过于频繁，请稍后再试。')
            self.windows[identity]=(minute,entry[1]+1)
            if model_call:self._count_model_call(day)

    def _count_model_call(self,day):
        if self.day!=day:self.day=day;self.daily_count=0
        require(not self.daily_calls or self.daily_count<self.daily_calls,'DAILY_LIMIT_REACHED','今日演示调用额度已用完，请明日再试。')
        if self.daily_calls and self.store:self.store.reserve_daily_call(day,self.daily_calls)
        self.daily_count+=1

    def count_model_call(self,at):
        with self.lock:self._count_model_call(int(at//86400))

    def acquire(self):
        require(not self.semaphore or self.semaphore.acquire(blocking=False),'MODEL_BUSY','当前体验人数较多，请稍后重试。')

    def release(self):
        if self.semaphore:self.semaphore.release()


@dataclass
class RuntimeOptions:
    public_origin: str = None
    invite_code: str = None
    signing_key: str = None
    bind_host: str = '127.0.0.1'

    def __post_init__(self):
        if self.public_origin:
            parsed=urlsplit(self.public_origin)
            require(parsed.scheme=='https' and bool(parsed.hostname) and not parsed.username and not parsed.password and not parsed.query and not parsed.fragment and not parsed.path,'RUNTIME_CONFIGURATION_INVALID','公开访问地址必须是无路径的 HTTPS 来源。')
        require(self.bind_host=='127.0.0.1' or bool(self.public_origin),'RUNTIME_CONFIGURATION_INVALID','非本机监听须配置明确的公开来源。')
        self.signing_key=self.signing_key or secrets.token_hex(32)

    @property
    def visitor_isolation_enabled(self):
        return bool(self.public_origin or self.invite_code)

    def validate_source(self,host,origin,port,method):
        allowed={f'127.0.0.1:{port}':f'http://127.0.0.1:{port}',f'localhost:{port}':f'http://localhost:{port}'}
        if self.public_origin:allowed[urlsplit(self.public_origin).netloc]=self.public_origin
        require(host in allowed,'HOST_REJECTED','访问来源未获允许。')
        require(not origin or origin==allowed[host],'ORIGIN_REJECTED','请求来源不匹配。')
        if self.public_origin and host==urlsplit(self.public_origin).netloc and method in ['POST','DELETE']:
            require(origin==self.public_origin,'ORIGIN_REJECTED','请求来源不匹配。')

    def issue_cookie(self,at=None):
        at=int(time.time() if at is None else at)
        raw=base64.urlsafe_b64encode(json.dumps([secrets.token_hex(24),at],separators=(',',':')).encode()).decode().rstrip('=')
        sig=hmac.new(self.signing_key.encode(),raw.encode(),hashlib.sha256).hexdigest()
        return raw+'.'+sig

    def visitor(self,header,at=None):
        if not self.visitor_isolation_enabled:return None
        at=time.time() if at is None else at
        try:
            cookie=SimpleCookie();cookie.load(header or '')
            raw,sig=cookie['yixu_visitor'].value.split('.')
            expected=hmac.new(self.signing_key.encode(),raw.encode(),hashlib.sha256).hexdigest()
            require(hmac.compare_digest(sig,expected),'ACCESS_REQUIRED')
            visitor,created=json.loads(base64.urlsafe_b64decode(raw+'='*(-len(raw)%4)))
            require(type(created) is int and created<=at<created+86400 and type(visitor) is str and len(visitor)==48,'ACCESS_REQUIRED')
            return visitor
        except (KeyError,ValueError,TypeError,Fault,OverflowError):
            raise Fault('ACCESS_REQUIRED','请输入邀请码进入演示。' if self.invite_code else '访客身份已过期，请刷新页面。') from None

    def authenticate(self,code):
        require(type(code) is str and bool(self.invite_code) and hmac.compare_digest(code,self.invite_code),'ACCESS_REQUIRED','邀请码不正确。')
