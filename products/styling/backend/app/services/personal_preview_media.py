"""Bounded decoding and private, immutable media for personal previews.

No user filename, URL, EXIF or raw upload is retained. These assets are never
mounted by StaticFiles; authorization belongs to the preview service.
"""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
from io import BytesIO
import os
from pathlib import Path
import re
import stat
import uuid
import warnings

from PIL import Image, ImageOps


class MediaError(Exception):
    def __init__(self, status: int, code: str):
        self.status, self.code = status, code
        super().__init__(code)


@dataclass(frozen=True)
class PhotoLimits:
    max_bytes: int = 5 * 1024 * 1024
    max_pixels: int = 20_000_000
    max_edge: int = 8192

    def __post_init__(self):
        if any(type(n) is not int or n <= 0 for n in
               (self.max_bytes, self.max_pixels, self.max_edge)):
            raise MediaError(503, "PREVIEW_STORAGE_UNAVAILABLE")


@dataclass(frozen=True)
class NormalizedPhoto:
    data: bytes
    raw_sha256: str
    sha256: str
    width: int
    height: int
    mime_type: str = "image/jpeg"

    @property
    def byte_size(self):
        return len(self.data)


async def read_upload(upload, limits: PhotoLimits | None = None) -> bytes:
    """Read UploadFile in bounded chunks, never upload.file.read() without size."""
    limits = limits or PhotoLimits()
    parts, size = [], 0
    while True:
        chunk = await upload.read(min(64 * 1024, limits.max_bytes + 1 - size))
        if not chunk:
            break
        size += len(chunk)
        if size > limits.max_bytes:
            raise MediaError(413, "PREVIEW_UPLOAD_TOO_LARGE")
        parts.append(chunk)
    return b"".join(parts)


def normalize_photo(raw: bytes, limits: PhotoLimits | None = None) -> NormalizedPhoto:
    limits = limits or PhotoLimits()
    if not isinstance(raw, bytes) or not raw:
        raise MediaError(422, "PREVIEW_PHOTO_INVALID")
    if len(raw) > limits.max_bytes:
        raise MediaError(413, "PREVIEW_UPLOAD_TOO_LARGE")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(BytesIO(raw)) as image:
                if image.format not in {"JPEG", "PNG", "WEBP"}:
                    raise MediaError(415, "PREVIEW_FORMAT_UNSUPPORTED")
                width, height = image.size
                if width <= 0 or height <= 0 or width * height > limits.max_pixels or max(width, height) > limits.max_edge:
                    raise MediaError(422, "PREVIEW_PIXELS_EXCEEDED")
                if getattr(image, "n_frames", 1) != 1 or getattr(image, "is_animated", False):
                    raise MediaError(422, "PREVIEW_PHOTO_INVALID")
                image.verify()
            with Image.open(BytesIO(raw)) as image:
                image.load()
                oriented = ImageOps.exif_transpose(image)
                # Rebuild pixels rather than forwarding image.info or metadata.
                converted = oriented.convert("RGBA")
                clean = Image.new("RGB", converted.size, (255, 255, 255))
                clean.paste(converted, mask=converted.getchannel("A"))
                output = BytesIO()
                clean.save(output, format="JPEG", quality=90, optimize=True)
                data = output.getvalue()
                width, height = clean.size
                clean.close()
                converted.close()
                if oriented is not image:
                    oriented.close()
    except MediaError:
        raise
    except (Image.DecompressionBombError, Image.DecompressionBombWarning):
        raise MediaError(422, "PREVIEW_PIXELS_EXCEEDED") from None
    except (OSError, ValueError, SyntaxError, TypeError, OverflowError):
        raise MediaError(422, "PREVIEW_PHOTO_INVALID") from None
    if len(data) > limits.max_bytes:
        raise MediaError(413, "PREVIEW_UPLOAD_TOO_LARGE")
    return NormalizedPhoto(data, hashlib.sha256(raw).hexdigest(),
                           hashlib.sha256(data).hexdigest(), width, height)


_KEY = re.compile(r"^(inputs|results)/[A-Za-z0-9_-]{1,128}\.jpg$")


class PrivateMediaStore:
    """Private directory descriptors, no symlink following or mutable overwrite."""
    def __init__(self, root):
        self.root = Path(root)
        if not self.root.is_absolute() or self.root.is_symlink():
            raise MediaError(503, "PREVIEW_STORAGE_UNAVAILABLE")
        try:
            # Existing permissive roots are configuration errors, not silently
            # adopted public directories. Only newly created folders are chmodded.
            if not self.root.exists():
                self.root.mkdir(parents=True, mode=0o700)
                os.chmod(self.root, 0o700)
            self._validate_directory(self.root)
            for name in ("inputs", "results"):
                path = self.root / name
                if not path.exists():
                    path.mkdir(mode=0o700)
                self._validate_directory(path)
        except (OSError, ValueError):
            raise MediaError(503, "PREVIEW_STORAGE_UNAVAILABLE") from None

    @staticmethod
    def _validate_directory(path):
        info = path.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_mode & 0o077:
            raise MediaError(503, "PREVIEW_STORAGE_UNAVAILABLE")

    def _directory(self, key):
        if not isinstance(key, str) or not _KEY.fullmatch(key):
            raise MediaError(503, "PREVIEW_STORAGE_UNAVAILABLE")
        kind, name = key.split("/")
        root_fd = None
        try:
            self._validate_directory(self.root)
            root_fd = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            fd = os.open(kind, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root_fd)
            if os.fstat(fd).st_mode & 0o077:
                os.close(fd)
                raise MediaError(503, "PREVIEW_STORAGE_UNAVAILABLE")
            return fd, name
        except (OSError, ValueError):
            raise MediaError(503, "PREVIEW_STORAGE_UNAVAILABLE") from None
        finally:
            if root_fd is not None:
                os.close(root_fd)

    def put(self, key: str, data: bytes) -> None:
        if not isinstance(data, bytes) or not data:
            raise MediaError(503, "PREVIEW_STORAGE_UNAVAILABLE")
        directory, name = self._directory(key)
        temporary = ".tmp-" + uuid.uuid4().hex
        fd = None
        try:
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                         0o600, dir_fd=directory)
            os.fchmod(fd, 0o600)
            with os.fdopen(fd, "wb") as output:
                fd = None
                output.write(data)
                output.flush()
                os.fsync(output.fileno())
            # Atomic creation without overwriting an older task/result.
            os.link(temporary, name, src_dir_fd=directory, dst_dir_fd=directory, follow_symlinks=False)
            os.unlink(temporary, dir_fd=directory)
            os.fsync(directory)
        except FileExistsError:
            raise MediaError(503, "PREVIEW_STORAGE_UNAVAILABLE") from None
        except (OSError, ValueError):
            raise MediaError(503, "PREVIEW_STORAGE_UNAVAILABLE") from None
        finally:
            if fd is not None:
                os.close(fd)
            try:
                os.unlink(temporary, dir_fd=directory)
            except FileNotFoundError:
                pass
            finally:
                os.close(directory)

    def read(self, key: str) -> bytes:
        directory, name = self._directory(key)
        fd = None
        try:
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory)
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_nlink != 1 or info.st_size > 20 * 1024 * 1024:
                raise MediaError(503, "PREVIEW_STORAGE_UNAVAILABLE")
            with os.fdopen(fd, "rb") as source:
                fd = None
                raw = source.read(20 * 1024 * 1024 + 1)
            if len(raw) != info.st_size:
                raise MediaError(503, "PREVIEW_STORAGE_UNAVAILABLE")
            return raw
        except FileNotFoundError:
            raise MediaError(404, "PREVIEW_NOT_FOUND") from None
        except (OSError, ValueError):
            raise MediaError(503, "PREVIEW_STORAGE_UNAVAILABLE") from None
        finally:
            if fd is not None:
                os.close(fd)
            os.close(directory)

    def remove(self, key: str) -> bool:
        directory, name = self._directory(key)
        try:
            os.unlink(name, dir_fd=directory)
            os.fsync(directory)
            return True
        except FileNotFoundError:
            return False
        except OSError:
            raise MediaError(503, "PREVIEW_STORAGE_UNAVAILABLE") from None
        finally:
            os.close(directory)

    def list_files(self) -> list[dict]:
        files = []
        for kind in ("inputs", "results"):
            directory, _ = self._directory(kind + "/scan.jpg")
            try:
                for name in os.listdir(directory):
                    key = kind + "/" + name
                    if not _KEY.fullmatch(key):
                        continue
                    info = os.stat(name, dir_fd=directory, follow_symlinks=False)
                    if stat.S_ISREG(info.st_mode):
                        files.append({"key": key, "mtime": info.st_mtime, "byte_size": info.st_size})
            finally:
                os.close(directory)
        return files

    def cleanup_temporary(self, before: float) -> int:
        """Remove only our abandoned atomic-write files after a hard deadline."""
        removed = 0
        for kind in ("inputs", "results"):
            directory, _ = self._directory(kind + "/scan.jpg")
            try:
                for name in os.listdir(directory):
                    if not re.fullmatch(r"\.tmp-[0-9a-f]{32}", name):
                        continue
                    info = os.stat(name, dir_fd=directory, follow_symlinks=False)
                    if stat.S_ISREG(info.st_mode) and info.st_mtime <= before:
                        os.unlink(name, dir_fd=directory)
                        removed += 1
                if removed:
                    os.fsync(directory)
            except OSError:
                raise MediaError(503, "PREVIEW_STORAGE_UNAVAILABLE") from None
            finally:
                os.close(directory)
        return removed
