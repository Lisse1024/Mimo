import json
import os
import re
import socket
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, unquote, urljoin, urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener, urlopen

from .video_context import extract_shared_video_clues, is_profile_share_text

def detect_link_platform(url: str) -> str:
    lowered = url.lower()
    if "xiaohongshu" in lowered or "xhslink" in lowered:
        return "小红书"
    if "douyin" in lowered or "iesdouyin" in lowered:
        return "抖音"
    if "bilibili" in lowered or "b23.tv" in lowered:
        return "B站"
    if "kuaishou" in lowered:
        return "快手"
    if "shipinhao" in lowered or "weixin.qq" in lowered:
        return "视频号"
    return "未知平台"


class NoRedirectHandler(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def is_public_http_url(url: str) -> bool:
    try:
        parsed = urlparse(url)
    except ValueError:
        return False
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return False
    host = parsed.hostname.lower()
    if host == "localhost" or host.endswith(".localhost"):
        return False
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror:
        return False
    for info in infos:
        try:
            ip = socket.gethostbyname(info[4][0])
            first, second = socket.inet_aton(ip)[0], socket.inet_aton(ip)[1]
        except OSError:
            return False
        if first in {0, 10, 127} or first >= 224:
            return False
        if first == 172 and 16 <= second <= 31:
            return False
        if first == 192 and second == 168:
            return False
        if first == 169 and second == 254:
            return False
    return True


def strip_html_text(value: str) -> str:
    text = re.sub(r"<[^>]+>", " ", value or "")
    replacements = {
        "&quot;": '"',
        "&#34;": '"',
        "&#39;": "'",
        "&amp;": "&",
        "&lt;": "<",
        "&gt;": ">",
        "&nbsp;": " ",
    }
    for old, new in replacements.items():
        text = text.replace(old, new)
    return re.sub(r"\s+", " ", text).strip()


def first_html_meta(html: str, patterns: list[str]) -> str:
    for pattern in patterns:
        match = re.search(pattern, html, flags=re.I | re.S)
        if match and match.group(1):
            return strip_html_text(match.group(1))[:240]
    return ""


def infer_page_kind_from_url(url: str) -> str:
    lowered = url.lower()
    if re.search(r"/share/user/|/user/|/profile/|sec_uid=|user_id=|uid=", lowered):
        return "profile"
    if re.search(r"/video/|/note/|/aweme/|modal_id=|item_id=|aweme_id=", lowered):
        return "work"
    return "unknown"


def extract_account_id_from_url(url: str) -> str:
    parsed = urlparse(url)
    query = parse_qs(parsed.query)
    for key in ("sec_uid", "user_id", "uid"):
        value = query.get(key, [""])[0]
        if value:
            return unquote(value)[:240]
    match = re.search(r"/(?:share/)?user/([^/?#]+)", parsed.path, flags=re.I)
    return unquote(match.group(1))[:240] if match else ""


def fetch_public_link_metadata(url: str) -> dict[str, Any]:
    if not is_public_http_url(url):
        return {"status": "skipped", "reason": "non_public_url"}
    current = url
    headers = {
        "User-Agent": "Mozilla/5.0 KOC-Agent/1.0 (+public metadata fetch)",
        "Accept": "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1",
    }
    opener = build_opener(NoRedirectHandler)
    redirects: list[str] = []
    final_response = None
    try:
        for _ in range(5):
            if not is_public_http_url(current):
                return {"status": "skipped", "reason": "redirected_to_non_public_url", "redirects": redirects}
            try:
                final_response = opener.open(Request(current, headers=headers), timeout=8)
                break
            except HTTPError as exc:
                if exc.code not in {301, 302, 303, 307, 308}:
                    return {"status": "failed", "reason": f"http_{exc.code}", "redirects": redirects}
                location = exc.headers.get("Location", "")
                if not location:
                    return {"status": "failed", "reason": f"redirect_without_location:{exc.code}", "redirects": redirects}
                current = urljoin(current, location)
                redirects.append(current)
        if final_response is None:
            return {"status": "failed", "reason": "too_many_redirects", "redirects": redirects}
        content_type = final_response.headers.get("Content-Type", "")
        html = final_response.read(250000).decode("utf-8", errors="replace")
        title = first_html_meta(
            html,
            [
                r"<meta[^>]+property=[\"']og:title[\"'][^>]+content=[\"']([^\"']+)[\"'][^>]*>",
                r"<meta[^>]+content=[\"']([^\"']+)[\"'][^>]+property=[\"']og:title[\"'][^>]*>",
                r"<title[^>]*>([\s\S]*?)</title>",
            ],
        )
        description = first_html_meta(
            html,
            [
                r"<meta[^>]+name=[\"']description[\"'][^>]+content=[\"']([^\"']+)[\"'][^>]*>",
                r"<meta[^>]+property=[\"']og:description[\"'][^>]+content=[\"']([^\"']+)[\"'][^>]*>",
                r"<meta[^>]+content=[\"']([^\"']+)[\"'][^>]+name=[\"']description[\"'][^>]*>",
            ],
        )
        canonical_url = first_html_meta(
            html,
            [
                r"<link[^>]+rel=[\"']canonical[\"'][^>]+href=[\"']([^\"']+)[\"'][^>]*>",
                r"<meta[^>]+property=[\"']og:url[\"'][^>]+content=[\"']([^\"']+)[\"'][^>]*>",
            ],
        )
        final_url = final_response.geturl() or current
        found_metadata = any([title, description, canonical_url, final_url != url])
        return {
            "status": "fetched" if found_metadata else "failed",
            "final_url": final_url,
            "redirects": redirects[:5],
            "http_status": getattr(final_response, "status", 200),
            "content_type": content_type,
            "title": title,
            "description": description,
            "canonical_url": canonical_url,
            "page_kind": infer_page_kind_from_url(final_url or canonical_url or url),
            "account_id": extract_account_id_from_url(final_url or canonical_url or url),
            "reason": "" if found_metadata else "no_metadata_found",
        }
    except (HTTPError, URLError, TimeoutError, OSError) as exc:
        return {"status": "failed", "reason": str(exc)[:180], "redirects": redirects}


def parse_work_links(raw: str) -> list[dict[str, Any]]:
    links: list[dict[str, Any]] = []
    seen: set[str] = set()
    for line in raw.splitlines():
        text = line.strip()
        if not text:
            continue
        shared_video_clues = extract_shared_video_clues(text)
        matches = re.findall(r"https?://[^\s，,；;]+", text)
        for url in matches or [text]:
            clean_url = url.strip().strip("。.).）")
            if not clean_url.startswith(("http://", "https://")) or clean_url in seen:
                continue
            seen.add(clean_url)
            page_kind_guess = "profile" if is_profile_share_text(text) or re.search(r"/share/user/|/user/|sec_uid|uid=", clean_url, flags=re.I) else "unknown"
            metadata = fetch_public_link_metadata(clean_url) if os.environ.get("KOC_FETCH_PUBLIC_LINK_METADATA", "1") != "0" else {"status": "skipped", "reason": "disabled"}
            metadata_page_kind = str(metadata.get("page_kind", "unknown"))
            final_url = str(metadata.get("final_url", ""))
            if page_kind_guess == "unknown" and metadata_page_kind in {"profile", "work"}:
                page_kind_guess = metadata_page_kind
            if page_kind_guess == "profile":
                shared_video_clues = {"title": "", "tags": [], "source_guess": "", "content_type": "unknown"}
            note_parts: list[str] = []
            if metadata.get("status") == "fetched":
                note_parts.append("已合法解析公开短链跳转和页面元信息。")
            elif metadata.get("reason"):
                note_parts.append(f"公开页面元信息获取受限：{metadata.get('reason')}")
            if final_url:
                note_parts.append(f"最终落点：{final_url[:240]}")
            links.append(
                {
                    "url": clean_url[:500],
                    "final_url": final_url[:500],
                    "platform_hint": detect_link_platform(clean_url),
                    "page_kind_guess": page_kind_guess,
                    "status": "saved_only",
                    "fetch_status": metadata.get("status", "skipped"),
                    "http_status": metadata.get("http_status"),
                    "account_id": str(metadata.get("account_id", ""))[:240],
                    "page_title": str(metadata.get("title", ""))[:240],
                    "page_description": str(metadata.get("description", ""))[:240],
                    "canonical_url": str(metadata.get("canonical_url", ""))[:500],
                    "shared_title": shared_video_clues.get("title", ""),
                    "shared_tags": shared_video_clues.get("tags", []),
                    "source_guess": shared_video_clues.get("source_guess", ""),
                    "content_type_guess": shared_video_clues.get("content_type", "unknown"),
                    "note": " ".join(note_parts) or "当前仅保存链接并作为策略上下文。",
                }
            )
            if len(links) >= 12:
                return links
    return links



