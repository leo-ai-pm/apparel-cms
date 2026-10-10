"""Initialize a new public intake through its real owner; no reception or synthetic rows."""
import argparse,json,os,stat,sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
parser=argparse.ArgumentParser();parser.add_argument("--env-file",required=True);args=parser.parse_args()
file=Path(args.env_file);info=file.lstat()
if not file.is_absolute() or file.is_symlink() or not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode)!=0o600:
    raise RuntimeError("Private environment JSON required")
env=json.loads(file.read_text())
if set(env)!={"PARTNER_MODE","PARTNER_CONFIG_FILE","PARTNER_DB_PATH"} or not all(isinstance(v,str) for v in env.values()):
    raise RuntimeError("Unexpected public environment fields")
os.environ.update(env)
from app.core.partner_config import config
from app.services.partner_db import connection
cfg=config()
if cfg["instance_id"]!="product-public-20261010" or cfg["authorized_scope"]!="public-three-agent-20261010":
    raise RuntimeError("Public instance/scope required")
with connection() as db:
    counts={name:db.execute("SELECT count(*) FROM "+name).fetchone()[0] for name in ["direct_receipts","direct_supplements","signals_v2","integration_attempts"]}
print(json.dumps({"initialized":True,"instance":cfg["instance_id"],"scope":cfg["authorized_scope"],"counts":counts,"business_seeded":False}))
