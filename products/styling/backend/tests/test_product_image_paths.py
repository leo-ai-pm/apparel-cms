"""Serve existing authorized product bytes independently from isolated business data."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

import pytest


BACKEND = Path(__file__).resolve().parents[1]
P001_SHA256 = "01bedea9b5709b36abc7b1d7958071bdb4d52473e9162eb8139ccede23303ae0"


class IsolatedEnvironment(dict):
    def __repr__(self):
        return "<isolated runtime environment>"


@pytest.fixture
def image_runtime(tmp_path):
    data = tmp_path / "isolated-data"
    assets = tmp_path / "registered-products"
    assets.mkdir()
    source_bytes = (BACKEND / "data/product-images/P001.png").read_bytes()
    assert hashlib.sha256(source_bytes).hexdigest() == P001_SHA256
    (assets / "P001.png").write_bytes(source_bytes)
    (tmp_path / "private.png").write_bytes(b"private-file-must-not-be-served")
    env = IsolatedEnvironment(os.environ)
    env.update({
        "DATA_DIR": str(data), "PRODUCT_IMAGE_DIR": str(assets),
        "DATABASE_URL": f"sqlite:///{tmp_path / 'isolated.db'}",
        "PYTHON_DOTENV_DISABLED": "1", "DEEPSEEK_API_KEY": "",
        "RUNNINGHUB_API_KEY": "", "TUDOU_API_KEY": "",
        "CMS_BASE_URL": "", "CMS_API_KEY": "",
        "STYLING_FIXED_OUTFITS_ENABLED": "0",
    })
    return data, assets, env


def run_runtime(code, env):
    process = subprocess.run(
        [sys.executable, "-c", code], cwd=BACKEND, env=env,
        capture_output=True, text=True, timeout=15,
    )
    assert process.returncode == 0, process.stderr
    return json.loads(process.stdout.strip().splitlines()[-1])


def test_product_image_directory_defaults_to_isolated_data(image_runtime):
    data, _, env = image_runtime
    env.pop("PRODUCT_IMAGE_DIR")
    result = run_runtime(
        "import json; from app.core import config; "
        "print(json.dumps({'path':str(getattr(config, 'PRODUCT_IMAGE_DIR', None))}))", env,
    )
    assert result["path"] == str(data / "product-images")


def test_product_image_directory_can_use_explicit_authorized_root(image_runtime):
    _, assets, env = image_runtime
    result = run_runtime(
        "import json; from app.core import config; "
        "print(json.dumps({'path':str(getattr(config, 'PRODUCT_IMAGE_DIR', None))}))", env,
    )
    assert result["path"] == str(assets)


def test_static_product_url_uses_authorized_bytes_without_data_copy(image_runtime):
    data, _, env = image_runtime
    result = run_runtime(
        "import hashlib,json; from fastapi.testclient import TestClient; "
        "from app.main import app; client=TestClient(app); "
        "response=client.get('/product-images/P001.png'); "
        "print(json.dumps({'status':response.status_code,"
        "'sha256':hashlib.sha256(response.content).hexdigest(),"
        "'type':response.headers.get('content-type'),"
        "'missing':client.get('/product-images/P999.png').status_code,"
        "'outside':client.get('/product-images/%2e%2e/private.png').status_code}))", env,
    )
    assert result["status"] == 200
    assert result["sha256"] == P001_SHA256
    assert result["type"] == "image/png"
    assert result["missing"] == result["outside"] == 404
    assert not (data / "product-images/P001.png").exists()
