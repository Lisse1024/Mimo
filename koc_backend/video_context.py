import json
import re
from typing import Any

def is_profile_share_text(text: str) -> bool:
    return bool(re.search(r"更多作品|TA\s*的更多作品|Ta\s*的更多作品|他的更多作品|她的更多作品|主页|个人页|share/user|/user/|sec_uid", text, flags=re.I))


def extract_shared_video_clues(text: str) -> dict[str, Any]:
    """Extract usable title/tag/source clues from platform share text."""
    urls = re.findall(r"https?://[^\s，,；;]+", text)
    before_url = text.split(urls[0], 1)[0] if urls else text
    before_url = re.sub(r"复制此链接.*$", "", before_url).strip()
    tags = [item.strip(" #　") for item in re.findall(r"#\s*([^#]+?)(?=\s+#|$)", before_url) if item.strip(" #　")]
    title_part = before_url.split("#", 1)[0].strip()
    title_part = re.sub(r"^[\d.]+\s*[A-Za-z0-9@:/._%-]*\s*", "", title_part).strip()
    title_part = re.sub(r"^[\d/:\sA-Za-z0-9@._%-]+", "", title_part).strip()
    generic_tags = {"治愈系动画", "动漫解说", "动画解说", "电影解说", "影视解说", "游戏解说", "音乐推荐", "音乐合集", "粤语", "戴上耳机"}
    source_guess = ""
    for tag in tags:
        if tag not in generic_tags and any(word in tag for word in ["当家", "电影", "剧", "番", "综艺", "游戏"]):
            source_guess = tag
            break
    if not source_guess:
        for tag in tags:
            if tag not in generic_tags:
                source_guess = tag
                break
    content_text = " ".join([title_part, *tags])
    if any(word in content_text for word in ["音乐", "粤语", "戴上耳机", "耳机", "歌单", "单曲", "歌词"]):
        content_type = "music"
    elif any(word in content_text for word in ["动漫", "动画", "番", "恐龙当家"]):
        content_type = "anime"
    elif any(word in content_text for word in ["电影", "影视"]):
        content_type = "film"
    elif any(word in content_text for word in ["电视剧", "剧集", "短剧"]):
        content_type = "tv_series"
    elif "综艺" in content_text:
        content_type = "variety"
    elif any(word in content_text for word in ["游戏", "手游", "端游"]):
        content_type = "game"
    else:
        content_type = "unknown"
    return {
        "title": title_part[:160],
        "tags": tags[:12],
        "source_guess": source_guess[:80],
        "content_type": content_type,
    }


VIDEO_TYPE_CAPSULES: dict[str, dict[str, list[str] | str]] = {
    "music": {
        "label": "音乐推荐/歌单切片",
        "focus": ["情绪文案", "歌曲/歌手线索", "高潮进入点", "歌词字幕", "画面氛围", "收藏/转发理由", "评论共鸣词"],
        "avoid": ["剧情反转模板", "影视片源判断", "游戏操作分析", "家居/探店/账号主页模板"],
        "forbidden_residue": ["恐龙当家", "最大的蛋", "最小的恐龙", "片源是", "人物关系"],
    },
    "anime": {
        "label": "动漫/动画解说切片",
        "focus": ["片源线索", "角色/设定反差", "可见剧情片段", "治愈/冲突情绪", "字幕解释", "同类桥段复刻"],
        "avoid": ["音乐歌单模板", "歌曲高潮进入点", "纯账号主页定位", "游戏操作复盘"],
        "forbidden_residue": ["粤语", "戴上耳机", "歌名", "歌手", "耳机沉浸"],
    },
    "film": {
        "label": "电影/影视切片",
        "focus": ["片名线索", "可见冲突", "人物关系", "台词/表情", "掐头去尾风险", "评论站队点", "版权/二创边界"],
        "avoid": ["音乐收藏理由模板", "游戏操作模板", "家居好物模板"],
        "forbidden_residue": ["粤语", "戴上耳机", "歌单", "恐龙当家"],
    },
    "tv_series": {
        "label": "剧集/短剧切片",
        "focus": ["角色关系", "短剧爽点", "反转/误会", "上下文缺口", "字幕解释密度", "追更/评论触发"],
        "avoid": ["音乐推荐模板", "游戏操作模板", "主页诊断模板"],
        "forbidden_residue": ["粤语", "戴上耳机", "歌名", "恐龙当家"],
    },
    "short_drama": {
        "label": "短剧切片",
        "focus": ["冲突前置", "关系张力", "反转节点", "字幕爽点", "评论站队", "下一集悬念"],
        "avoid": ["音乐推荐模板", "游戏操作模板", "主页诊断模板"],
        "forbidden_residue": ["粤语", "戴上耳机", "歌名", "恐龙当家"],
    },
    "variety": {
        "label": "综艺/娱乐片段",
        "focus": ["嘉宾关系", "笑点/尴尬点", "反应镜头", "金句字幕", "话题争议", "二创标题"],
        "avoid": ["音乐推荐模板", "影视剧情补全", "游戏操作模板"],
        "forbidden_residue": ["粤语", "戴上耳机", "恐龙当家"],
    },
    "game": {
        "label": "游戏/实况片段",
        "focus": ["游戏名/模式", "操作节点", "胜负反差", "队友/对手反应", "解说节奏", "复盘指标"],
        "avoid": ["音乐推荐模板", "影视剧情片源模板", "家居好物模板"],
        "forbidden_residue": ["粤语", "戴上耳机", "恐龙当家", "片源是"],
    },
    "unknown": {
        "label": "未知单条作品",
        "focus": ["当前可见事实", "用户标题/标签", "内容类型待确认", "缺失证据", "低风险复刻测试"],
        "avoid": ["直接套用音乐/影视/游戏任一固定模板", "编造片名、歌名、游戏名或完整剧情"],
        "forbidden_residue": [],
    },
}


def infer_video_prompt_profile(profile: dict[str, Any], asset_analysis: dict[str, Any] | None = None) -> dict[str, Any]:
    if profile.get("task_intent") == "account_growth_diagnosis":
        capsule = VIDEO_TYPE_CAPSULES["unknown"]
        return {
            "content_type": "account_profile",
            "label": "账号主页诊断",
            "focus": ["账号定位", "主页转粉", "内容结构", "作品矩阵", "冷启动下一步"],
            "avoid": ["影视片源判断", "剧情片段复刻", "单条视频镜头脚本", "编造视频上下文"],
            "forbidden_residue": ["片源判断", "影视/剧情切片", "疑似影视", "片段语义", "角色关系"],
            "titles": [],
            "tags": [],
            "source_guess": "",
        }
    work_links = profile.get("work_links", []) if isinstance(profile.get("work_links"), list) else []
    link_titles = [str(item.get("shared_title", "")) for item in work_links if isinstance(item, dict) and item.get("shared_title")]
    link_tags = [
        str(tag)
        for item in work_links
        if isinstance(item, dict)
        for tag in (item.get("shared_tags") if isinstance(item.get("shared_tags"), list) else [])
    ]
    link_source_guess = next(
        (
            str(item.get("source_guess", ""))
            for item in work_links
            if isinstance(item, dict) and item.get("source_guess")
        ),
        "",
    )
    link_content_type = next(
        (
            str(item.get("content_type_guess", "unknown"))
            for item in work_links
            if isinstance(item, dict) and item.get("content_type_guess") not in {"", "unknown"}
        ),
        "unknown",
    )
    source = (asset_analysis or {}).get("source_identification") if isinstance((asset_analysis or {}).get("source_identification"), dict) else {}
    source_type = str(source.get("content_type") or link_content_type or "unknown")
    if source_type == "tv_drama":
        source_type = "tv_series"
    if source_type not in VIDEO_TYPE_CAPSULES:
        source_type = "unknown"
    capsule = VIDEO_TYPE_CAPSULES[source_type]
    evidence_text = " ".join([str(profile.get("user_request", "")), profile.get("work_links_raw", ""), " ".join(link_titles), " ".join(link_tags)])
    if source_type == "unknown":
        clues = extract_shared_video_clues(evidence_text)
        guessed = clues.get("content_type", "unknown")
        source_type = guessed if guessed in VIDEO_TYPE_CAPSULES else "unknown"
        capsule = VIDEO_TYPE_CAPSULES[source_type]
    return {
        "content_type": source_type,
        "label": capsule["label"],
        "focus": capsule["focus"],
        "avoid": capsule["avoid"],
        "forbidden_residue": capsule["forbidden_residue"],
        "titles": link_titles,
        "tags": link_tags,
        "source_guess": link_source_guess,
    }


def video_prompt_capsule_text(video_profile: dict[str, Any]) -> str:
    return (
        f"本轮视频类型路由：{video_profile['label']}。\n"
        f"只关注这些变量：{'、'.join(video_profile.get('focus', []))}。\n"
        f"明确避免：{'、'.join(video_profile.get('avoid', []))}。\n"
        "禁止把其它视频类型的模板、片名、歌名、游戏名或上一轮案例残留带入本轮。"
        "如果当前证据不足，必须写“待确认”，不能用示例内容补空。"
    )


def bundle_has_cross_type_residue(bundle: dict[str, Any], video_profile: dict[str, Any]) -> bool:
    evidence = " ".join(
        [
            " ".join(video_profile.get("titles", [])),
            " ".join(video_profile.get("tags", [])),
            str(video_profile.get("source_guess", "")),
        ]
    )
    text = json.dumps(bundle, ensure_ascii=False)
    for token in video_profile.get("forbidden_residue", []):
        if token and token in text and token not in evidence:
            return True
    return False

