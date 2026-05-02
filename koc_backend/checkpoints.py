from typing import Any


class CheckpointManager:
    def __init__(self, enabled: bool) -> None:
        self.enabled = enabled
        self._checkpointer: Any | None = None

    def get(self) -> Any | None:
        if not self.enabled:
            return None
        if self._checkpointer is None:
            from langgraph.checkpoint.memory import MemorySaver

            self._checkpointer = MemorySaver()
        return self._checkpointer

    @property
    def ready(self) -> bool:
        return self.enabled and self._checkpointer is not None
