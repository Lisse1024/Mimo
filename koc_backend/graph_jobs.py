from typing import Any, Callable

from koc_graph import build_koc_graph, build_runtime, graph_invoke_config


def run_strategy_graph_job(
    job_id: str,
    runtime_deps: dict[str, Any],
    checkpointer: Any | None,
    mark_failed: Callable[[str], None],
) -> None:
    try:
        runtime = build_runtime(**runtime_deps)
        graph = build_koc_graph(runtime, checkpointer=checkpointer)
        graph.invoke({"job_id": job_id}, config=graph_invoke_config(job_id))
    except Exception as exc:  # noqa: BLE001
        mark_failed(str(exc))
