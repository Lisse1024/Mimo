from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlparse

from .agent_runner import CHECKPOINTS, create_strategy_job_and_start
from .profile_validation import validate_profile
from .catalog import PLATFORM_LIBRARY, TRACK_LIBRARY
from .config import BASE_DIR, DATA_DIR, ENABLE_IN_MEMORY_CHECKPOINTS, HOST, KIMI_TEXT_MODEL, KIMI_VISION_MODEL, MOONSHOT_API_KEY, PORT
from .http_utils import json_response, read_json_body
from .jobs_state import get_async_job
from .profiles import load_store, profile_for_client, save_store
from .workspace_service import (
    generate_calendar,
    generate_post_pack,
    generate_review,
    generate_strategy,
    update_task_status,
    workspace_payload,
)

class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        route = parsed.path
        store = load_store()

        if route == "/api/bootstrap":
            json_response(
                self,
                200,
                {
                    "ok": True,
                    "model": KIMI_TEXT_MODEL,
                    "has_api_key": bool(MOONSHOT_API_KEY),
                    "vision_model": KIMI_VISION_MODEL,
                    "has_vision_api_key": bool(MOONSHOT_API_KEY),
                    "default_mode": "advisor",
                    "available_modes": [
                        {"value": "advisor", "label": "主控增长 Agent"},
                    ],
                    "platform_options": [
                        {"value": key, "label": item["name"], "bias": item["bias"]}
                        for key, item in PLATFORM_LIBRARY.items()
                    ],
                    "track_options": [
                        {"value": key, "label": item["name"], "keywords": item["keywords"]}
                        for key, item in TRACK_LIBRARY.items()
                    ],
                    "profiles": [profile_for_client(item) for item in store["profiles"]],
                },
            )
            return

        if route == "/api/workspace":
            profile_id = parse_qs(parsed.query).get("profile_id", [""])[0]
            if not profile_id:
                json_response(self, 400, {"error": "缺少 profile_id。"})
                return
            try:
                json_response(self, 200, workspace_payload(store, profile_id))
            except ValueError as exc:
                json_response(self, 404, {"error": str(exc)})
            return

        if route == "/api/strategy-jobs":
            job_id = parse_qs(parsed.query).get("job_id", [""])[0]
            if not job_id:
                json_response(self, 400, {"error": "缺少 job_id。"})
                return
            try:
                json_response(self, 200, get_async_job(job_id))
            except ValueError as exc:
                json_response(self, 404, {"error": str(exc)})
            return

        if route == "/api/health":
            from koc_graph.runtime import REQUIRED_RUNTIME_KEYS

            json_response(
                self,
                200,
                {
                    "ok": True,
                    "product": "KOC LangGraph Agent",
                    "architecture": "langgraph",
                    "langgraph": {
                        "runtime_dependency_count": len(REQUIRED_RUNTIME_KEYS),
                        "in_memory_checkpoints": ENABLE_IN_MEMORY_CHECKPOINTS,
                        "checkpointer_ready": CHECKPOINTS.ready,
                    },
                    "base_dir": str(BASE_DIR),
                    "data_dir": str(DATA_DIR),
                    "bootstrap": "/api/bootstrap",
                },
            )
            return

        if route == "/":
            json_response(
                self,
                200,
                {
                    "ok": True,
                    "product": "KOC LangGraph Agent",
                    "message": "Standalone backend API is running.",
                    "bootstrap": "/api/bootstrap",
                    "health": "/api/health",
                },
            )
            return

        json_response(self, 404, {"error": "Not found"})

    def do_POST(self) -> None:
        route = urlparse(self.path).path
        try:
            store = load_store()
            payload = read_json_body(self)
            if route == "/api/profiles":
                profile = validate_profile(payload)
                store["profiles"].append(profile)
                store["workspaces"][profile["id"]] = {}
                save_store(store)
                json_response(
                    self,
                    200,
                    {
                        "profile": profile_for_client(profile),
                        "profiles": [profile_for_client(item) for item in store["profiles"]],
                    },
                )
                return

            if route == "/api/strategy":
                json_response(self, 200, generate_strategy(store, payload.get("profile_id", "")))
                return

            if route == "/api/strategy-jobs":
                json_response(self, 200, create_strategy_job_and_start(store, payload.get("profile_id", ""), payload.get("mode", "advisor")))
                return

            if route == "/api/calendar":
                json_response(self, 200, generate_calendar(store, payload.get("profile_id", "")))
                return

            if route == "/api/post-pack":
                json_response(self, 200, generate_post_pack(store, payload.get("profile_id", ""), int(payload.get("day_index", -1))))
                return

            if route == "/api/review":
                json_response(self, 200, generate_review(store, payload.get("profile_id", ""), payload))
                return

            if route == "/api/tasks/update":
                json_response(self, 200, update_task_status(store, payload.get("profile_id", ""), payload))
                return

            json_response(self, 404, {"error": "Not found"})
        except ValueError as exc:
            json_response(self, 400, {"error": str(exc)})
        except RuntimeError as exc:
            json_response(self, 500, {"error": str(exc)})
        except Exception as exc:  # noqa: BLE001
            json_response(self, 500, {"error": f"服务异常：{exc}"})

    def log_message(self, format: str, *args: Any) -> None:
        return


def main() -> None:
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Server running at http://{HOST}:{PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()




