"""Downloading an approved photograph, and making it web-sized.

Downloading is kept apart from searching for a reason: a search finding an
image says nothing about whether the server will hand it over. The three
outcomes are told apart and stored.

  ok               the file arrived and is a real image
  download_blocked the host refused us (401/403/451, or an HTML page instead
                   of an image, which is what a hotlink block looks like)
  download_failed  a timeout, a connection drop, a 404, a 5xx, a file that is
                   not an image, or one bigger than the limit

Only approved candidates are ever fetched. Nothing downloads itself.
"""
from __future__ import annotations

import hashlib
import io
from pathlib import Path

import requests

try:
    from PIL import Image
except ImportError:  # Pillow is in requirements.txt; this keeps imports honest
    Image = None

BLOCKED_STATUSES = {401, 402, 403, 406, 451}
IMAGE_TYPES = ("image/jpeg", "image/png", "image/webp", "image/gif", "image/avif", "image/jpg")


class DownloadResult(dict):
    """A plain dict so it can go straight into the downloads table."""


def download_candidate(candidate: dict, settings, *, session=None) -> DownloadResult:
    """Fetch one image and write both the original and an optimised copy."""
    url = candidate["image_url"]
    http = session or requests

    if url.startswith("file://") or candidate.get("provider") == "upload":
        # An uploaded photograph is already on this machine.
        local = Path(url.replace("file://", ""))
        if not local.exists():
            return DownloadResult(status="download_failed", error_kind="missing_file",
                                  error_detail=f"{local} is not there any more")
        data = local.read_bytes()
        return _store(data, candidate, settings, source_name=local.name)

    headers = {
        "User-Agent": "all-star-players-image-finder/1.0 (storefront photo sourcing)",
        "Accept": "image/avif,image/webp,image/png,image/jpeg,*/*;q=0.8",
    }
    if candidate.get("source_page"):
        # Some hosts serve the image only to a request that looks like it came
        # from the page it sits on. Sending that is honest: that IS where we
        # found it.
        headers["Referer"] = candidate["source_page"]

    try:
        response = http.get(url, headers=headers, timeout=settings.http_timeout,
                            stream=True, allow_redirects=True)
    except requests.RequestException as exc:
        kind = "timeout" if "timeout" in type(exc).__name__.lower() else "network"
        return DownloadResult(status="download_failed", error_kind=kind, error_detail=str(exc)[:300])

    try:
        if response.status_code in BLOCKED_STATUSES:
            return DownloadResult(status="download_blocked", error_kind=f"http_{response.status_code}",
                                  error_detail="the host refused to serve the image to us")
        if response.status_code != 200:
            return DownloadResult(status="download_failed", error_kind=f"http_{response.status_code}",
                                  error_detail=f"the host answered {response.status_code}")

        content_type = (response.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        if content_type.startswith("text/html"):
            # A login wall or an interstitial rather than the picture.
            return DownloadResult(status="download_blocked", error_kind="html_instead_of_image",
                                  error_detail="the host sent a web page instead of the image")

        limit = settings.max_download_bytes
        chunks, total = [], 0
        for chunk in response.iter_content(64 * 1024):
            chunks.append(chunk)
            total += len(chunk)
            if total > limit:
                return DownloadResult(status="download_failed", error_kind="too_large",
                                      error_detail=f"larger than {limit // (1024 * 1024)} MB")
        data = b"".join(chunks)
    finally:
        response.close()

    if not data:
        return DownloadResult(status="download_failed", error_kind="empty",
                              error_detail="the host sent an empty body")
    return _store(data, candidate, settings, content_type=content_type)


def _store(data: bytes, candidate: dict, settings, *, content_type: str = "",
           source_name: str = "") -> DownloadResult:
    if Image is None:
        return DownloadResult(status="download_failed", error_kind="pillow_missing",
                              error_detail="Pillow is not installed; run pip install -r requirements.txt")

    digest = hashlib.sha256(data).hexdigest()
    try:
        with Image.open(io.BytesIO(data)) as probe:
            probe.verify()                      # catches "it is not an image"
        with Image.open(io.BytesIO(data)) as img:
            img = img.convert("RGB") if img.mode not in ("RGB", "L") else img
            width, height = img.size
            optimised = _resize(img, settings.optimized_max_edge)
    except Exception as exc:  # Pillow raises a zoo of exceptions here
        return DownloadResult(status="download_failed", error_kind="not_an_image",
                              error_detail=f"{type(exc).__name__}: {exc}"[:300])

    settings.ensure_dirs()
    square_id = candidate.get("square_id") or "unknown"
    stem = f"{square_id}-{digest[:10]}"
    suffix = _suffix(content_type, source_name)
    original_path = settings.originals_dir / f"{stem}{suffix}"
    original_path.write_bytes(data)

    optimised_path = settings.optimized_dir / f"{stem}.jpg"
    optimised.save(optimised_path, "JPEG", quality=settings.optimized_quality, optimize=True,
                   progressive=True)

    return DownloadResult(
        status="ok", error_kind=None, error_detail=None,
        local_path=str(original_path), optimized_path=str(optimised_path),
        bytes=len(data), width=width, height=height, sha256=digest,
    )


def _resize(img, max_edge: int):
    width, height = img.size
    if max(width, height) <= max_edge:
        return img.copy()
    scale = max_edge / float(max(width, height))
    return img.resize((max(1, int(width * scale)), max(1, int(height * scale))),
                      Image.LANCZOS)


def _suffix(content_type: str, source_name: str) -> str:
    if source_name and "." in source_name:
        return "." + source_name.rsplit(".", 1)[1].lower()
    return {
        "image/jpeg": ".jpg", "image/jpg": ".jpg", "image/png": ".png",
        "image/webp": ".webp", "image/gif": ".gif", "image/avif": ".avif",
    }.get(content_type, ".img")
