import json

from common.bed_presence import BedPresence
from common.fork_presence import FORK_PRESENCE_STALE_S, ForkPresence


class Clock:
    def __init__(self, t=0.0):
        self.t = t

    def __call__(self):
        return self.t


def _write(path, ts, left=True, right=False, version=1):
    path.write_text(json.dumps({
        "version": version,
        "ts": ts,
        "left": {"occupied": left, "since": ts - 60},
        "right": {"occupied": right, "since": None},
    }))


def _detector_file(path, left, ts):
    path.write_text(json.dumps({
        "version": 1,
        "left": {"vitals_presence": left, "vitals_evidence_ts": ts},
        "right": {"vitals_presence": left, "vitals_evidence_ts": ts},
    }))


def test_reads_state_and_since(tmp_path):
    path = tmp_path / "fork.json"
    _write(path, 1000.0)
    fork = ForkPresence(path, clock=Clock(), wall=lambda: 1000.0)
    assert fork.state("left") == (True, 940.0)
    assert fork.state("right") == (False, None)


def test_unknown_without_a_file_or_with_a_bad_one(tmp_path):
    path = tmp_path / "fork.json"
    assert ForkPresence(path, clock=Clock(), wall=lambda: 0.0).occupied("left") is None
    path.write_text("{nope")
    assert ForkPresence(path, clock=Clock(), wall=lambda: 0.0).occupied("left") is None
    _write(path, 0.0, version=2)
    assert ForkPresence(path, clock=Clock(), wall=lambda: 0.0).occupied("left") is None


def test_stale_file_is_unknown(tmp_path):
    path = tmp_path / "fork.json"
    _write(path, 1000.0)
    wall = Clock(1000.0 + FORK_PRESENCE_STALE_S + 1)
    assert ForkPresence(path, clock=Clock(), wall=wall).occupied("left") is None


def test_reloads_after_the_interval(tmp_path):
    path = tmp_path / "fork.json"
    _write(path, 1000.0, left=True)
    clock = Clock()
    fork = ForkPresence(path, clock=clock, wall=lambda: 1000.0)
    assert fork.occupied("left") is True
    _write(path, 1000.0, left=False)
    assert fork.occupied("left") is True
    clock.t = 10.0
    assert fork.occupied("left") is False


def test_bed_presence_prefers_the_fork_then_falls_back(tmp_path):
    state = tmp_path / "state.json"
    fork_path = tmp_path / "fork.json"
    _detector_file(state, True, 1000.0)
    _write(fork_path, 1000.0, left=False)
    fork = ForkPresence(fork_path, clock=Clock(), wall=lambda: 1000.0)
    bed = BedPresence(state, clock=Clock(), wall=lambda: 1000.0, fork=fork)
    assert bed.occupied("left") is False
    fork_path.unlink()
    fallback = BedPresence(state, clock=Clock(), wall=lambda: 1000.0,
                           fork=ForkPresence(fork_path, clock=Clock(), wall=lambda: 1000.0))
    assert fallback.occupied("left") is True
