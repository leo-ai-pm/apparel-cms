"""Single-host SQLite persistence. Each session is committed as one atomic row."""
import json
import os
from pathlib import Path
import sqlite3
import threading

from .core import Fault, instant


class SQLiteStore:
    def __init__(self, path):
        self.path=Path(path);self.path.parent.mkdir(parents=True,exist_ok=True)
        fd=os.open(str(self.path),os.O_CREAT|os.O_RDWR,0o600);os.close(fd);os.chmod(self.path,0o600)
        self.lock=threading.RLock()
        self.db=sqlite3.connect(str(self.path),check_same_thread=False,timeout=10)
        self.db.execute('PRAGMA secure_delete=ON')
        self.db.execute('CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, expires REAL NOT NULL, payload TEXT NOT NULL)')
        self.db.execute('CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)');self.db.commit()

    def load(self, at):
        with self.lock,self.db:
            self.db.execute('DELETE FROM sessions WHERE expires<=?',(instant(at).timestamp(),))
            return {sid:json.loads(payload) for sid,payload in self.db.execute('SELECT id,payload FROM sessions')}

    def get(self, sid):
        with self.lock:
            row=self.db.execute('SELECT payload FROM sessions WHERE id=?',(sid,)).fetchone()
            return json.loads(row[0]) if row else None

    def save(self, row, expected=None):
        state=row['state'];payload=json.dumps(row,ensure_ascii=False,separators=(',',':'))
        with self.lock,self.db:
            args=(row['conversation_revision'],instant(state['expires_at']).timestamp(),payload,state['session_id'])
            if expected is None:
                self.db.execute('INSERT INTO sessions(revision,expires,payload,id) VALUES(?,?,?,?)',args)
            else:
                cursor=self.db.execute('UPDATE sessions SET revision=?,expires=?,payload=? WHERE id=? AND revision=?',args+(expected,))
                if cursor.rowcount!=1:raise Fault('STATE_REVISION_CONFLICT','另一条请求已更新对话，请刷新后重试。')

    def delete(self,sid):
        with self.lock,self.db:self.db.execute('DELETE FROM sessions WHERE id=?',(sid,))

    def secret(self,key,default):
        with self.lock,self.db:
            self.db.execute('INSERT OR IGNORE INTO metadata(key,value) VALUES(?,?)',(key,default))
            return self.db.execute('SELECT value FROM metadata WHERE key=?',(key,)).fetchone()[0]

    def value(self,key,default=None):
        with self.lock:
            row=self.db.execute('SELECT value FROM metadata WHERE key=?',(key,)).fetchone()
            return json.loads(row[0]) if row else default

    def set_value(self,key,value):
        with self.lock,self.db:
            self.db.execute('INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)',(key,json.dumps(value,ensure_ascii=False)))

    def reserve_daily_call(self,day,limit):
        with self.lock,self.db:
            row=self.db.execute("SELECT value FROM metadata WHERE key='daily_model_calls'").fetchone()
            saved=json.loads(row[0]) if row else {'day':day,'count':0}
            count=saved['count'] if saved['day']==day else 0
            if count>=limit:raise Fault('DAILY_LIMIT_REACHED','今日演示调用额度已用完，请明日再试。')
            self.db.execute("INSERT OR REPLACE INTO metadata(key,value) VALUES('daily_model_calls',?)",(json.dumps({'day':day,'count':count+1}),))

    def close(self):
        with self.lock:self.db.close()
