from __future__ import annotations

import py_compile
import sys
from pathlib import Path


PROJECT_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_DIR))


def compile_python_files() -> None:
    for path in PROJECT_DIR.rglob("*.py"):
        if ".venv" in path.parts or "__pycache__" in path.parts:
            continue
        py_compile.compile(str(path), doraise=True)


def assert_removed_single_file_backends() -> None:
    for path in [
        PROJECT_DIR / "server.py",
        PROJECT_DIR / "koc_backend" / "app.py",
    ]:
        if path.exists():
            raise AssertionError(f"Removed backend shim still exists: {path}")


def assert_database_contract() -> None:
    schema_path = PROJECT_DIR / "database" / "schema.sql"
    if not schema_path.exists():
        raise AssertionError(f"Missing production database schema: {schema_path}")
    schema_sql = schema_path.read_text(encoding="utf-8").lower()
    required = [
        "platform_accounts",
        "works",
        "experiments",
        "evidence_items",
        "embedding",
    ]
    for fragment in required:
        if fragment not in schema_sql:
            raise AssertionError(f"Database schema is missing: {fragment}")


def assert_gateway_contract() -> None:
    files = [
        PROJECT_DIR / "apps" / "server" / "src" / "index.ts",
        PROJECT_DIR / "apps" / "server" / "src" / "koc-growth.ts",
        PROJECT_DIR / "apps" / "server" / "src" / "platform-connectors.ts",
        PROJECT_DIR / "apps" / "server" / "src" / "media-analysis.ts",
        PROJECT_DIR / "apps" / "server" / "src" / "koc-memory.ts",
    ]
    combined = "\n".join(path.read_text(encoding="utf-8") for path in files)
    required = [
        'app.get("/api/koc/readiness"',
        'app.get("/api/koc/agenda"',
        'app.post("/api/koc/memory/review"',
        'app.post("/api/koc/diagnose"',
        "platform.connector_v1",
        "processUploadedMedia",
        "buildVideoUnderstanding",
        "人工回填数据",
        "OCR/ASR",
        "recordKocExperimentReview",
    ]
    for fragment in required:
        if fragment not in combined:
            raise AssertionError(f"Gateway contract is missing: {fragment}")

    forbidden = [
        "douyin" + "-open-api",
        "platform." + "douyin" + "_open_api_v1",
        "DOUYIN" + "_OPEN_ENABLED",
        "/auth/" + "douyin",
        "/api/" + "douyin",
        "official" + "Api",
        "official" + "_api",
    ]
    for fragment in forbidden:
        if fragment in combined:
            raise AssertionError(f"Removed official API fragment still exists: {fragment}")


def assert_backend_imports() -> None:
    from koc_backend.profile_validation import validate_profile
    from koc_backend.work_understanding import build_work_understanding

    profile = validate_profile(
        {
            "nickname": "测试用户",
            "account_name": "测试账号",
            "stage": "cold-start",
            "platform": "douyin",
            "track": "knowledge-edu",
            "cadence": "每周 3 条",
            "audience": "新手创作者",
            "goal": "分析当前视频",
            "strengths": "表达清晰",
            "constraints": "时间有限",
            "result_mode": "single_work_analysis",
        }
    )
    work = build_work_understanding(profile, {"status": "no_assets"})
    if work.get("schema_version") != "work_understanding.v1":
        raise AssertionError("Expected normalized work understanding schema")


def main() -> None:
    compile_python_files()
    assert_removed_single_file_backends()
    assert_database_contract()
    assert_gateway_contract()
    assert_backend_imports()
    print("Self check passed.")


if __name__ == "__main__":
    main()
