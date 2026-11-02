"""
Who is in bed, according to the fork's detector.

The sleepypod server decides this from weight and vibration together and
writes each side's state to a small file. The Python modules read it first, so
a side only logs while someone is on it. If the file goes stale they fall back
to their own check, so false vitals can return during a long outage.
"""

import json
import logging
import math
import os
import time
from pathlib import Path
from typing import Callable, Optional, Tuple

log = logging.getLogger("fork_presence")

STATE_VERSION = 1
FORK_PRESENCE_RELOAD_S = 5.0
# The server rewrites the file every minute while detection is live.
FORK_PRESENCE_STALE_S = 300.0


def default_path(data_dir: Path) -> Path:
    return Path(os.environ.get("FORK_PRESENCE_PATH", str(data_dir / "fork-presence.json")))


class ForkPresence:
    def __init__(self, path: Path, reload_s: float = FORK_PRESENCE_RELOAD_S,
                 stale_s: float = FORK_PRESENCE_STALE_S,
                 clock: Callable[[], float] = time.monotonic,
                 wall: Callable[[], float] = time.time):
        self._path = path
        self._reload_s = reload_s
        self._stale_s = stale_s
        self._clock = clock
        self._wall = wall
        self._state: Optional[dict] = None
        self._loaded_at: Optional[float] = None
        self._available = False

    def state(self, side: str) -> Optional[Tuple[bool, Optional[float]]]:
        """(occupied, since) from the fork's detector, or None when unknown."""
        self._maybe_reload()
        if self._state is None:
            return None
        ts = self._state.get("ts")
        if type(ts) not in (int, float):
            return None
        age = self._wall() - ts
        if not math.isfinite(age) or age < 0 or age > self._stale_s:
            return None
        entry = self._state.get(side)
        if not isinstance(entry, dict) or type(entry.get("occupied")) is not bool:
            return None
        since = entry.get("since")
        return entry["occupied"], since if type(since) in (int, float) else None

    def occupied(self, side: str) -> Optional[bool]:
        known = self.state(side)
        return None if known is None else known[0]

    def _maybe_reload(self) -> None:
        now = self._clock()
        if self._loaded_at is not None and now - self._loaded_at < self._reload_s:
            return
        self._loaded_at = now
        try:
            with open(self._path, encoding="utf-8") as f:
                state = json.load(f)
        except (OSError, ValueError):
            self._set(None)
            return
        self._set(state if isinstance(state, dict) and state.get("version") == STATE_VERSION else None)

    def _set(self, state: Optional[dict]) -> None:
        self._state = state
        available = state is not None
        if available != self._available:
            log.info("Fork presence %s", "available" if available else "unavailable; using the local check")
            self._available = available
