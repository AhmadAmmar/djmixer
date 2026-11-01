from __future__ import annotations

import csv
import math
import os
import queue
import shutil
import subprocess
import tempfile
import threading
import traceback
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

import librosa
import numpy as np
from matplotlib.backends.backend_tkagg import FigureCanvasTkAgg, NavigationToolbar2Tk
from matplotlib.figure import Figure
from pydub import AudioSegment

import tkinter as tk
from tkinter import filedialog, messagebox, ttk


APP_TITLE = "Python DJ Mixer — waveform, beat grid and tempo matching"
DEFAULT_SAMPLE_RATE = 44_100
DEFAULT_TARGET_DBFS = -16.0
DEFAULT_CROSSFADE_SECONDS = 12.0
DEFAULT_CROSSFADE_BARS = 8.0
DEFAULT_FIXED_TARGET_BPM = 120.0
DEFAULT_MAX_TEMPO_CHANGE_PCT = 8.0
WAVEFORM_POINTS = 6_000
SUPPORTED_AUDIO_TYPES = (
    ("Audio files", "*.mp3 *.wav *.flac *.m4a *.aac *.ogg"),
    ("MP3 files", "*.mp3"),
    ("All files", "*.*"),
)


@dataclass
class TrackInfo:
    path: Path
    uid: str = field(default_factory=lambda: uuid.uuid4().hex)
    duration_s: float | None = None
    estimated_bpm: float | None = None
    bpm_override: float | None = None
    beat_times_s: list[float] = field(default_factory=list)
    median_beat_interval_s: float | None = None
    estimated_bars_4_4: float | None = None
    first_beat_s: float | None = None
    approx_key: str | None = None
    avg_dbfs: float | None = None
    peak_dbfs: float | None = None
    sample_rate: int | None = None
    channels: int | None = None
    cue_in_s: float = 0.0
    cue_out_s: float | None = None
    waveform_times_s: np.ndarray = field(default_factory=lambda: np.array([], dtype=float), repr=False)
    waveform_envelope: np.ndarray = field(default_factory=lambda: np.array([], dtype=float), repr=False)
    status: str = "Not analysed"

    @property
    def filename(self) -> str:
        return self.path.name

    @property
    def effective_bpm(self) -> float | None:
        return self.bpm_override if self.bpm_override is not None else self.estimated_bpm

    @property
    def effective_cue_out_s(self) -> float | None:
        return self.cue_out_s if self.cue_out_s is not None else self.duration_s

    @property
    def selected_duration_s(self) -> float | None:
        end = self.effective_cue_out_s
        if end is None:
            return None
        return max(0.0, end - self.cue_in_s)


@dataclass(frozen=True)
class RenderSettings:
    crossfade_mode: str
    fixed_crossfade_seconds: float
    crossfade_bars: float
    gain_match: bool
    target_dbfs: float
    tempo_match: bool
    tempo_mode: str
    fixed_target_bpm: float
    max_tempo_change_pct: float
    allow_half_double_correction: bool


@dataclass(frozen=True)
class TempoPlanItem:
    track_uid: str
    filename: str
    source_bpm: float | None
    interpreted_source_bpm: float | None
    requested_target_bpm: float | None
    output_bpm: float | None
    stretch_rate: float
    stretch_pct: float
    apply_stretch: bool
    reason: str


# Krumhansl-Schmuckler pitch-class profiles. The key estimate is a browsing aid,
# not a replacement for listening or specialist DJ key-detection software.
MAJOR_PROFILE = np.array(
    [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88],
    dtype=float,
)
MINOR_PROFILE = np.array(
    [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17],
    dtype=float,
)
NOTE_NAMES = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"]


def finite_or_none(value: float | int | np.number | None) -> float | None:
    if value is None:
        return None
    number = float(value)
    return number if math.isfinite(number) else None


def format_seconds(value: float | None) -> str:
    if value is None:
        return "—"
    minutes = int(value // 60)
    seconds = value - minutes * 60
    return f"{minutes}:{seconds:05.2f}"


def format_number(value: float | None, digits: int = 1) -> str:
    if value is None:
        return "—"
    return f"{value:.{digits}f}"


def estimate_key(y: np.ndarray, sr: int) -> str | None:
    """Estimate one global major/minor key from average chroma energy."""
    if y.size == 0:
        return None
    chroma = librosa.feature.chroma_stft(y=y, sr=sr, n_fft=4096)
    mean_chroma = np.nanmean(chroma, axis=1)
    if not np.any(np.isfinite(mean_chroma)) or np.allclose(mean_chroma, 0):
        return None
    mean_chroma = np.nan_to_num(mean_chroma, nan=0.0)
    scores: list[tuple[float, str]] = []
    for tonic, note in enumerate(NOTE_NAMES):
        major_score = np.corrcoef(mean_chroma, np.roll(MAJOR_PROFILE, tonic))[0, 1]
        minor_score = np.corrcoef(mean_chroma, np.roll(MINOR_PROFILE, tonic))[0, 1]
        scores.append((float(major_score), f"{note} major"))
        scores.append((float(minor_score), f"{note} minor"))
    valid_scores = [(score, label) for score, label in scores if math.isfinite(score)]
    return max(valid_scores, default=(0.0, "Unknown"), key=lambda item: item[0])[1]


def build_waveform_envelope(y: np.ndarray, sr: int, max_points: int = WAVEFORM_POINTS) -> tuple[np.ndarray, np.ndarray]:
    """Build a compact peak envelope suitable for interactive plotting."""
    if y.size == 0:
        return np.array([], dtype=float), np.array([], dtype=float)
    mono = np.asarray(y, dtype=float).reshape(-1)
    samples_per_bin = max(1, int(math.ceil(mono.size / max_points)))
    bins = int(math.ceil(mono.size / samples_per_bin))
    padded = np.pad(mono, (0, bins * samples_per_bin - mono.size), mode="constant")
    envelope = np.max(np.abs(padded.reshape(bins, samples_per_bin)), axis=1)
    centres = (np.arange(bins, dtype=float) * samples_per_bin + samples_per_bin / 2.0) / sr
    return centres, envelope


def analyse_track(track: TrackInfo) -> TrackInfo:
    """Populate analysis fields for one file without modifying manual overrides."""
    track.status = "Analysing…"
    y, sr = librosa.load(track.path, sr=None, mono=True)
    if y.size == 0:
        raise ValueError("The decoded audio file contains no samples.")

    tempo_raw, beat_frames = librosa.beat.beat_track(y=y, sr=sr, trim=False)
    tempo_array = np.asarray(tempo_raw).reshape(-1)
    estimated_bpm = finite_or_none(tempo_array[0] if tempo_array.size else None)
    beat_times = librosa.frames_to_time(beat_frames, sr=sr).astype(float).tolist()
    intervals = np.diff(beat_times) if len(beat_times) >= 2 else np.array([], dtype=float)

    segment = AudioSegment.from_file(track.path)
    duration_s = len(segment) / 1000.0
    waveform_times, waveform_envelope = build_waveform_envelope(y, sr)

    track.duration_s = duration_s
    track.estimated_bpm = estimated_bpm
    track.beat_times_s = beat_times
    track.first_beat_s = beat_times[0] if beat_times else None
    track.median_beat_interval_s = finite_or_none(np.median(intervals) if intervals.size else None)
    track.estimated_bars_4_4 = len(beat_times) / 4.0 if beat_times else None
    track.approx_key = estimate_key(y, sr)
    track.avg_dbfs = finite_or_none(segment.dBFS)
    track.peak_dbfs = finite_or_none(segment.max_dBFS)
    track.sample_rate = int(segment.frame_rate)
    track.channels = int(segment.channels)
    track.waveform_times_s = waveform_times
    track.waveform_envelope = waveform_envelope

    if track.cue_out_s is None or track.cue_out_s > duration_s:
        track.cue_out_s = duration_s
    track.status = "Analysed"
    return track


def choose_interpreted_bpm(source_bpm: float, target_bpm: float, allow_half_double: bool) -> float:
    """Resolve common half/double BPM tracker ambiguity without altering audio."""
    if not allow_half_double:
        return source_bpm
    candidates = [source_bpm * 0.5, source_bpm, source_bpm * 2.0]
    return min(candidates, key=lambda value: abs(value - target_bpm) / max(target_bpm, 1e-9))


def build_tempo_plan(tracks: list[TrackInfo], settings: RenderSettings) -> list[TempoPlanItem]:
    """Create a deterministic, sequential tempo-matching plan for preview/export."""
    plan: list[TempoPlanItem] = []
    previous_output_bpm: float | None = None

    for index, track in enumerate(tracks):
        source = track.effective_bpm
        if source is None or source <= 0:
            item = TempoPlanItem(
                track_uid=track.uid,
                filename=track.filename,
                source_bpm=source,
                interpreted_source_bpm=source,
                requested_target_bpm=None,
                output_bpm=source,
                stretch_rate=1.0,
                stretch_pct=0.0,
                apply_stretch=False,
                reason="Tempo unavailable: render at native speed",
            )
            plan.append(item)
            previous_output_bpm = item.output_bpm or previous_output_bpm
            continue

        if not settings.tempo_match:
            item = TempoPlanItem(
                track_uid=track.uid,
                filename=track.filename,
                source_bpm=source,
                interpreted_source_bpm=source,
                requested_target_bpm=source,
                output_bpm=source,
                stretch_rate=1.0,
                stretch_pct=0.0,
                apply_stretch=False,
                reason="Tempo matching disabled",
            )
            plan.append(item)
            previous_output_bpm = source
            continue

        if settings.tempo_mode == "fixed":
            target = settings.fixed_target_bpm
        elif index == 0 or previous_output_bpm is None:
            target = source
        else:
            target = previous_output_bpm

        interpreted = choose_interpreted_bpm(source, target, settings.allow_half_double_correction)
        rate = target / interpreted
        change_pct = abs(rate - 1.0) * 100.0

        if change_pct > settings.max_tempo_change_pct + 1e-9:
            output = interpreted
            apply_stretch = False
            reason = (
                f"Skipped: required {change_pct:.2f}% change exceeds "
                f"{settings.max_tempo_change_pct:.2f}% safety limit"
            )
            applied_rate = 1.0
        elif abs(rate - 1.0) < 0.0005:
            output = interpreted
            apply_stretch = False
            reason = "Already tempo-compatible"
            applied_rate = 1.0
        else:
            output = target
            apply_stretch = True
            reason = "Apply offline pitch-preserving time stretch"
            applied_rate = rate

        item = TempoPlanItem(
            track_uid=track.uid,
            filename=track.filename,
            source_bpm=source,
            interpreted_source_bpm=interpreted,
            requested_target_bpm=target,
            output_bpm=output,
            stretch_rate=applied_rate,
            stretch_pct=change_pct if apply_stretch else 0.0,
            apply_stretch=apply_stretch,
            reason=reason,
        )
        plan.append(item)
        previous_output_bpm = output

    return plan


def apply_simple_gain_matching(segment: AudioSegment, target_dbfs: float) -> AudioSegment:
    current_dbfs = finite_or_none(segment.dBFS)
    if current_dbfs is None:
        return segment
    gain_change = max(-12.0, min(12.0, target_dbfs - current_dbfs))
    return segment.apply_gain(gain_change)


def audiosegment_to_float_array(segment: AudioSegment) -> np.ndarray:
    """Convert a 16-bit AudioSegment to a channels × samples floating array."""
    if segment.sample_width != 2:
        segment = segment.set_sample_width(2)
    raw = np.asarray(segment.get_array_of_samples(), dtype=np.int16)
    if segment.channels <= 0:
        raise ValueError("Audio segment has no channels.")
    frames = raw.reshape((-1, segment.channels)).T.astype(np.float32)
    return frames / 32768.0


def float_array_to_audiosegment(samples: np.ndarray, frame_rate: int) -> AudioSegment:
    """Convert channels × samples floats back to an interleaved 16-bit segment."""
    audio = np.asarray(samples, dtype=np.float32)
    if audio.ndim == 1:
        audio = audio[np.newaxis, :]
    if audio.ndim != 2 or audio.shape[0] < 1:
        raise ValueError("Time-stretched audio has an unexpected shape.")
    pcm = np.clip(audio, -1.0, 1.0)
    interleaved = (pcm.T.reshape(-1) * 32767.0).astype(np.int16)
    return AudioSegment(
        data=interleaved.tobytes(),
        sample_width=2,
        frame_rate=frame_rate,
        channels=int(audio.shape[0]),
    )


def time_stretch_segment(segment: AudioSegment, rate: float) -> AudioSegment:
    """Pitch-preserving offline time stretch using librosa's phase-vocoder path."""
    if rate <= 0:
        raise ValueError("Tempo stretch rate must be positive.")
    if abs(rate - 1.0) < 0.0005:
        return segment
    samples = audiosegment_to_float_array(segment)
    stretched = librosa.effects.time_stretch(samples, rate=rate)
    return float_array_to_audiosegment(stretched, segment.frame_rate)


class DJMixerApp:
    def __init__(self, root: tk.Tk) -> None:
        self.root = root
        self.root.title(APP_TITLE)
        self.root.geometry("1700x1040")
        self.root.minsize(1220, 780)

        self.tracks: list[TrackInfo] = []
        self.preview_process: subprocess.Popen[bytes] | None = None
        self.preview_temp_path: Path | None = None
        self.busy = False
        self.ui_queue: queue.Queue[tuple[Callable[..., None], tuple[object, ...]]] = queue.Queue()

        self.crossfade_mode_var = tk.StringVar(value="bars")
        self.crossfade_seconds_var = tk.StringVar(value=str(DEFAULT_CROSSFADE_SECONDS))
        self.crossfade_bars_var = tk.StringVar(value=str(DEFAULT_CROSSFADE_BARS))
        self.gain_match_var = tk.BooleanVar(value=True)
        self.target_dbfs_var = tk.StringVar(value=str(DEFAULT_TARGET_DBFS))

        self.tempo_match_var = tk.BooleanVar(value=True)
        self.tempo_mode_var = tk.StringVar(value="previous")
        self.fixed_target_bpm_var = tk.StringVar(value=str(DEFAULT_FIXED_TARGET_BPM))
        self.max_tempo_change_pct_var = tk.StringVar(value=str(DEFAULT_MAX_TEMPO_CHANGE_PCT))
        self.allow_half_double_var = tk.BooleanVar(value=True)

        self.snap_dragged_cues_var = tk.BooleanVar(value=True)
        self.show_beats_var = tk.BooleanVar(value=True)
        self.show_bar_guides_var = tk.BooleanVar(value=True)

        self.status_var = tk.StringVar(value="Ready")
        self.cue_in_var = tk.StringVar(value="0.0")
        self.cue_out_var = tk.StringVar(value="")
        self.bpm_override_var = tk.StringVar(value="")

        self.figure: Figure | None = None
        self.ax = None
        self.canvas: FigureCanvasTkAgg | None = None
        self.cue_in_line = None
        self.cue_out_line = None
        self.dragging_cue: str | None = None

        self._build_ui()
        self._drain_ui_queue()
        self._log_environment()
        self.root.protocol("WM_DELETE_WINDOW", self.on_close)

    # ---------- UI construction ----------

    def _build_ui(self) -> None:
        toolbar = ttk.Frame(self.root, padding=(8, 8, 8, 4))
        toolbar.pack(fill="x")
        self._button(toolbar, "Add audio files", self.add_tracks).pack(side="left", padx=3)
        self._button(toolbar, "Remove", self.remove_selected).pack(side="left", padx=3)
        self._button(toolbar, "Move up", lambda: self.move_selected(-1)).pack(side="left", padx=3)
        self._button(toolbar, "Move down", lambda: self.move_selected(1)).pack(side="left", padx=3)
        ttk.Separator(toolbar, orient="vertical").pack(side="left", fill="y", padx=8)
        self._button(toolbar, "Analyse selected", self.analyse_selected).pack(side="left", padx=3)
        self._button(toolbar, "Analyse all", self.analyse_all).pack(side="left", padx=3)
        ttk.Separator(toolbar, orient="vertical").pack(side="left", fill="y", padx=8)
        self._button(toolbar, "Preview source", self.preview_selected_source).pack(side="left", padx=3)
        self._button(toolbar, "Preview processed", self.preview_selected_processed).pack(side="left", padx=3)
        self._button(toolbar, "Stop preview", self.stop_preview).pack(side="left", padx=3)
        ttk.Separator(toolbar, orient="vertical").pack(side="left", fill="y", padx=8)
        self._button(toolbar, "Export mix", self.export_mix).pack(side="left", padx=3)
        self._button(toolbar, "Export analysis CSV", self.export_analysis_csv).pack(side="left", padx=3)

        settings = ttk.Frame(self.root, padding=(8, 2, 8, 4))
        settings.pack(fill="x")
        self._build_mix_settings(settings)
        self._build_tempo_settings(settings)

        main_pane = ttk.Panedwindow(self.root, orient="vertical")
        main_pane.pack(fill="both", expand=True, padx=8, pady=(0, 6))
        table_frame = ttk.Frame(main_pane)
        waveform_frame = ttk.Frame(main_pane)
        bottom_frame = ttk.Panedwindow(main_pane, orient="horizontal")
        main_pane.add(table_frame, weight=2)
        main_pane.add(waveform_frame, weight=4)
        main_pane.add(bottom_frame, weight=3)

        self._build_track_table(table_frame)
        self._build_waveform_panel(waveform_frame)
        self._build_details_panel(bottom_frame)
        self._build_transition_panel(bottom_frame)
        self._build_log_panel(bottom_frame)

        footer = ttk.Frame(self.root, padding=(8, 4, 8, 8))
        footer.pack(fill="x")
        self.progress = ttk.Progressbar(footer, mode="determinate", maximum=100)
        self.progress.pack(side="left", fill="x", expand=True, padx=(0, 10))
        ttk.Label(footer, textvariable=self.status_var).pack(side="right")

        for variable in (
            self.crossfade_seconds_var,
            self.crossfade_bars_var,
            self.fixed_target_bpm_var,
            self.max_tempo_change_pct_var,
        ):
            variable.trace_add("write", lambda *_: self.refresh_transition_plan())

    @staticmethod
    def _button(parent: tk.Misc, text: str, command: Callable[[], None]) -> ttk.Button:
        return ttk.Button(parent, text=text, command=command)

    def _build_mix_settings(self, parent: ttk.Frame) -> None:
        frame = ttk.LabelFrame(parent, text="Crossfade and gain", padding=7)
        frame.pack(side="left", fill="x", expand=True, padx=(0, 4))
        ttk.Label(frame, text="Overlap:").pack(side="left")
        ttk.Radiobutton(
            frame, text="seconds", value="seconds", variable=self.crossfade_mode_var, command=self.refresh_transition_plan
        ).pack(side="left", padx=(5, 2))
        ttk.Entry(frame, width=6, textvariable=self.crossfade_seconds_var).pack(side="left", padx=(0, 8))
        ttk.Radiobutton(
            frame, text="4/4 bars", value="bars", variable=self.crossfade_mode_var, command=self.refresh_transition_plan
        ).pack(side="left", padx=(3, 2))
        ttk.Entry(frame, width=6, textvariable=self.crossfade_bars_var).pack(side="left", padx=(0, 12))
        ttk.Checkbutton(frame, text="Gain match", variable=self.gain_match_var).pack(side="left", padx=(2, 3))
        ttk.Label(frame, text="Target dBFS:").pack(side="left")
        ttk.Entry(frame, width=7, textvariable=self.target_dbfs_var).pack(side="left", padx=(3, 0))

    def _build_tempo_settings(self, parent: ttk.Frame) -> None:
        frame = ttk.LabelFrame(parent, text="Offline tempo matching", padding=7)
        frame.pack(side="left", fill="x", expand=True, padx=(4, 0))
        ttk.Checkbutton(
            frame, text="Enable", variable=self.tempo_match_var, command=self.refresh_transition_plan
        ).pack(side="left", padx=(0, 5))
        ttk.Radiobutton(
            frame, text="Match previous track", value="previous", variable=self.tempo_mode_var, command=self.refresh_transition_plan
        ).pack(side="left", padx=(2, 3))
        ttk.Radiobutton(
            frame, text="Fixed BPM", value="fixed", variable=self.tempo_mode_var, command=self.refresh_transition_plan
        ).pack(side="left", padx=(5, 2))
        ttk.Entry(frame, width=6, textvariable=self.fixed_target_bpm_var).pack(side="left", padx=(0, 8))
        ttk.Label(frame, text="Max change %:").pack(side="left")
        ttk.Entry(frame, width=6, textvariable=self.max_tempo_change_pct_var).pack(side="left", padx=(3, 8))
        ttk.Checkbutton(
            frame, text="Resolve half/double BPM ambiguity", variable=self.allow_half_double_var, command=self.refresh_transition_plan
        ).pack(side="left")

    def _build_track_table(self, parent: ttk.Frame) -> None:
        frame = ttk.LabelFrame(parent, text="Track order and analysis", padding=6)
        frame.pack(fill="both", expand=True)
        columns = (
            "order", "file", "duration", "estimated_bpm", "override", "effective_bpm", "key",
            "beats", "bars", "avg_dbfs", "cue_in", "cue_out", "status"
        )
        self.tree = ttk.Treeview(frame, columns=columns, show="headings", selectmode="browse")
        headings = {
            "order": "#", "file": "File", "duration": "Duration", "estimated_bpm": "Est. BPM",
            "override": "BPM override", "effective_bpm": "Used BPM", "key": "Approx. key",
            "beats": "Beats", "bars": "Est. 4/4 bars", "avg_dbfs": "Avg dBFS", "cue_in": "Cue in",
            "cue_out": "Cue out", "status": "Status"
        }
        widths = {
            "order": 38, "file": 275, "duration": 78, "estimated_bpm": 70, "override": 82,
            "effective_bpm": 70, "key": 90, "beats": 62, "bars": 82, "avg_dbfs": 68,
            "cue_in": 66, "cue_out": 66, "status": 105
        }
        for column in columns:
            self.tree.heading(column, text=headings[column])
            self.tree.column(column, width=widths[column], minwidth=38, stretch=(column == "file"))
        yscroll = ttk.Scrollbar(frame, orient="vertical", command=self.tree.yview)
        xscroll = ttk.Scrollbar(frame, orient="horizontal", command=self.tree.xview)
        self.tree.configure(yscrollcommand=yscroll.set, xscrollcommand=xscroll.set)
        self.tree.grid(row=0, column=0, sticky="nsew")
        yscroll.grid(row=0, column=1, sticky="ns")
        xscroll.grid(row=1, column=0, sticky="ew")
        frame.rowconfigure(0, weight=1)
        frame.columnconfigure(0, weight=1)
        self.tree.bind("<<TreeviewSelect>>", self.on_track_selected)
        self.tree.bind("<Double-1>", lambda _event: self.preview_selected_source())

    def _build_waveform_panel(self, parent: ttk.Frame) -> None:
        frame = ttk.LabelFrame(parent, text="Waveform editor: drag cue markers; use toolbar to zoom and pan", padding=5)
        frame.pack(fill="both", expand=True)
        controls = ttk.Frame(frame)
        controls.pack(fill="x", pady=(0, 3))
        ttk.Button(controls, text="Fit waveform", command=self.fit_waveform).pack(side="left", padx=3)
        ttk.Button(controls, text="Snap both cues to nearest beats", command=self.snap_selected_cues_to_beats).pack(side="left", padx=3)
        ttk.Checkbutton(controls, text="Snap dragged cues to beats", variable=self.snap_dragged_cues_var).pack(side="left", padx=8)
        ttk.Checkbutton(controls, text="Show beat markers", variable=self.show_beats_var, command=self.refresh_waveform).pack(side="left", padx=8)
        ttk.Checkbutton(controls, text="Emphasise every fourth detected beat", variable=self.show_bar_guides_var, command=self.refresh_waveform).pack(side="left", padx=8)
        ttk.Label(
            controls,
            text="Every fourth marker is only a counting guide; this version does not infer verified downbeats or phrases.",
        ).pack(side="left", padx=(12, 0))

        self.figure = Figure(figsize=(10, 3.4), dpi=100)
        self.ax = self.figure.add_subplot(111)
        self.canvas = FigureCanvasTkAgg(self.figure, master=frame)
        self.canvas.draw()
        self.canvas.get_tk_widget().pack(fill="both", expand=True)
        mpl_toolbar = NavigationToolbar2Tk(self.canvas, frame, pack_toolbar=False)
        mpl_toolbar.update()
        mpl_toolbar.pack(fill="x")
        self.canvas.mpl_connect("button_press_event", self.on_waveform_press)
        self.canvas.mpl_connect("motion_notify_event", self.on_waveform_motion)
        self.canvas.mpl_connect("button_release_event", self.on_waveform_release)
        self.refresh_waveform()

    def _build_details_panel(self, parent: ttk.Panedwindow) -> None:
        frame = ttk.LabelFrame(parent, text="Selected-track cues and metadata", padding=7)
        parent.add(frame, weight=2)
        form = ttk.Frame(frame)
        form.pack(fill="x", pady=(0, 6))
        ttk.Label(form, text="Cue in (s):").pack(side="left")
        ttk.Entry(form, width=9, textvariable=self.cue_in_var).pack(side="left", padx=(3, 7))
        ttk.Label(form, text="Cue out (s):").pack(side="left")
        ttk.Entry(form, width=9, textvariable=self.cue_out_var).pack(side="left", padx=(3, 7))
        ttk.Label(form, text="BPM override:").pack(side="left")
        ttk.Entry(form, width=8, textvariable=self.bpm_override_var).pack(side="left", padx=(3, 7))
        ttk.Button(form, text="Apply", command=self.apply_selected_edits).pack(side="left", padx=3)
        ttk.Button(form, text="Use first beat", command=self.use_first_beat_as_cue_in).pack(side="left", padx=3)
        ttk.Button(form, text="Clear BPM override", command=self.clear_bpm_override).pack(side="left", padx=3)
        self.details_text = self._text_with_scroll(frame)

    def _build_transition_panel(self, parent: ttk.Panedwindow) -> None:
        frame = ttk.LabelFrame(parent, text="Transition and tempo-matching plan", padding=7)
        parent.add(frame, weight=2)
        self.transition_text = self._text_with_scroll(frame)

    def _build_log_panel(self, parent: ttk.Panedwindow) -> None:
        frame = ttk.LabelFrame(parent, text="Log", padding=7)
        parent.add(frame, weight=2)
        self.log_text = self._text_with_scroll(frame)

    @staticmethod
    def _text_with_scroll(parent: ttk.Frame) -> tk.Text:
        holder = ttk.Frame(parent)
        holder.pack(fill="both", expand=True)
        text = tk.Text(holder, wrap="word", height=10, state="disabled")
        scroll = ttk.Scrollbar(holder, orient="vertical", command=text.yview)
        text.configure(yscrollcommand=scroll.set)
        text.pack(side="left", fill="both", expand=True)
        scroll.pack(side="right", fill="y")
        return text

    # ---------- generic UI helpers ----------

    def call_ui(self, callback: Callable[..., None], *args: object) -> None:
        self.ui_queue.put((callback, args))

    def _drain_ui_queue(self) -> None:
        try:
            while True:
                callback, args = self.ui_queue.get_nowait()
                callback(*args)
        except queue.Empty:
            pass
        try:
            self.root.after(50, self._drain_ui_queue)
        except tk.TclError:
            pass

    def set_busy(self, busy: bool, status: str | None = None) -> None:
        self.busy = busy
        self.status_var.set(status or ("Busy" if busy else "Ready"))

    def set_progress(self, value: float, status: str | None = None) -> None:
        self.progress["value"] = max(0.0, min(100.0, value))
        if status:
            self.status_var.set(status)

    @staticmethod
    def append_text(widget: tk.Text, text: str) -> None:
        widget.configure(state="normal")
        widget.insert("end", text)
        widget.see("end")
        widget.configure(state="disabled")

    @staticmethod
    def replace_text(widget: tk.Text, text: str) -> None:
        widget.configure(state="normal")
        widget.delete("1.0", "end")
        widget.insert("1.0", text)
        widget.configure(state="disabled")

    def log(self, text: str) -> None:
        self.append_text(self.log_text, f"{text}\n")

    def log_from_worker(self, text: str) -> None:
        self.call_ui(self.log, text)

    def _log_environment(self) -> None:
        ffmpeg = shutil.which("ffmpeg")
        ffplay = shutil.which("ffplay")
        self.log(f"FFmpeg: {ffmpeg or 'not found on PATH'}")
        self.log(f"ffplay preview helper: {ffplay or 'not found on PATH'}")
        self.log("Tempo stretch engine: librosa.effects.time_stretch (offline, pitch-preserving phase-vocoder path)")
        if not ffmpeg:
            self.log("MP3 decoding/export requires FFmpeg. Install it before rendering mixes.")

    # ---------- track state ----------

    def get_track_by_uid(self, uid: str) -> TrackInfo | None:
        return next((track for track in self.tracks if track.uid == uid), None)

    def selected_track(self) -> TrackInfo | None:
        selected = self.tree.selection()
        return self.get_track_by_uid(selected[0]) if selected else None

    def refresh_table(self, select_uid: str | None = None) -> None:
        current = select_uid or (self.tree.selection()[0] if self.tree.selection() else None)
        self.tree.delete(*self.tree.get_children())
        for index, track in enumerate(self.tracks, start=1):
            self.tree.insert(
                "", "end", iid=track.uid,
                values=(
                    index, track.filename, format_seconds(track.duration_s), format_number(track.estimated_bpm, 1),
                    format_number(track.bpm_override, 1), format_number(track.effective_bpm, 1), track.approx_key or "—",
                    len(track.beat_times_s) if track.beat_times_s else "—", format_number(track.estimated_bars_4_4, 1),
                    format_number(track.avg_dbfs, 1), format_number(track.cue_in_s, 2),
                    format_number(track.effective_cue_out_s, 2), track.status,
                )
            )
        if current and self.tree.exists(current):
            self.tree.selection_set(current)
            self.tree.focus(current)
            self.tree.see(current)
        self.refresh_transition_plan()
        self.refresh_selected_details()
        self.refresh_waveform()

    def on_track_selected(self, _event: object | None = None) -> None:
        self.refresh_selected_details()
        self.refresh_waveform()

    def refresh_selected_details(self) -> None:
        track = self.selected_track()
        if not track:
            self.cue_in_var.set("0.0")
            self.cue_out_var.set("")
            self.bpm_override_var.set("")
            self.replace_text(self.details_text, "Select a track to inspect it.\n")
            return
        self.cue_in_var.set(f"{track.cue_in_s:.3f}")
        self.cue_out_var.set("" if track.effective_cue_out_s is None else f"{track.effective_cue_out_s:.3f}")
        self.bpm_override_var.set("" if track.bpm_override is None else f"{track.bpm_override:.3f}")
        beat_preview = ", ".join(f"{value:.3f}" for value in track.beat_times_s[:20])
        if len(track.beat_times_s) > 20:
            beat_preview += ", …"
        if not beat_preview:
            beat_preview = "Not available until analysis has completed."
        plan_item = self.tempo_plan_for_uid(track.uid)
        lines = [
            f"File: {track.path}",
            f"Status: {track.status}",
            f"Duration: {format_seconds(track.duration_s)}",
            f"Selected source region: {format_seconds(track.selected_duration_s)}",
            f"Estimated tempo: {format_number(track.estimated_bpm, 2)} BPM",
            f"Manual BPM override: {format_number(track.bpm_override, 2)}",
            f"Tempo used for planning: {format_number(track.effective_bpm, 2)} BPM",
            f"Detected beats: {len(track.beat_times_s) if track.beat_times_s else '—'}",
            f"Estimated 4/4 bars: {format_number(track.estimated_bars_4_4, 2)}",
            f"Median beat interval: {format_number(track.median_beat_interval_s, 4)} s",
            f"First detected beat: {format_number(track.first_beat_s, 3)} s",
            f"Approximate global key: {track.approx_key or '—'}",
            f"Average level: {format_number(track.avg_dbfs, 2)} dBFS",
            f"Peak level: {format_number(track.peak_dbfs, 2)} dBFS",
            f"Audio format: {track.sample_rate or '—'} Hz, {track.channels or '—'} channel(s)",
        ]
        if plan_item:
            lines += [
                "",
                "Current processed-preview/export plan:",
                f"Interpreted source tempo: {format_number(plan_item.interpreted_source_bpm, 2)} BPM",
                f"Requested target tempo: {format_number(plan_item.requested_target_bpm, 2)} BPM",
                f"Expected rendered tempo: {format_number(plan_item.output_bpm, 2)} BPM",
                f"Stretch rate: {plan_item.stretch_rate:.5f}×",
                f"Action: {plan_item.reason}",
            ]
        lines += [
            "",
            "First detected beat timestamps (source-track seconds):",
            beat_preview,
            "",
            "Interpretation note: BPM, beats and key are estimates. Cue markers are stored in source-track time. "
            "Processed preview and export apply the current offline tempo plan afterwards.",
        ]
        self.replace_text(self.details_text, "\n".join(lines) + "\n")

    # ---------- waveform ----------

    def refresh_waveform(self, preserve_xlim: bool = False) -> None:
        if self.ax is None or self.canvas is None:
            return
        old_xlim = self.ax.get_xlim() if preserve_xlim else None
        self.ax.clear()
        self.cue_in_line = None
        self.cue_out_line = None
        track = self.selected_track()
        if not track:
            self.ax.text(0.5, 0.5, "Select a track to display its waveform.", ha="center", va="center", transform=self.ax.transAxes)
            self.ax.set_axis_off()
            self.canvas.draw_idle()
            return
        self.ax.set_axis_on()
        if track.waveform_times_s.size == 0 or track.waveform_envelope.size == 0:
            self.ax.text(0.5, 0.5, "Analyse this track to generate its waveform and beat grid.", ha="center", va="center", transform=self.ax.transAxes)
            self.ax.set_xlim(0, max(1.0, track.duration_s or 1.0))
            self.ax.set_ylim(-1.05, 1.05)
            self.ax.set_xlabel("Source-track time (seconds)")
            self.canvas.draw_idle()
            return
        times = track.waveform_times_s
        env = track.waveform_envelope
        self.ax.fill_between(times, -env, env, alpha=0.55, linewidth=0.0)
        if self.show_beats_var.get() and track.beat_times_s:
            self.ax.vlines(track.beat_times_s, -1.0, 1.0, linewidth=0.55, alpha=0.28)
        if self.show_bar_guides_var.get() and track.beat_times_s:
            self.ax.vlines(track.beat_times_s[::4], -1.0, 1.0, linewidth=1.0, alpha=0.62)
        cue_out = track.effective_cue_out_s if track.effective_cue_out_s is not None else (track.duration_s or 0.0)
        self.cue_in_line = self.ax.axvline(track.cue_in_s, linewidth=2.0, label="Cue in")
        self.cue_out_line = self.ax.axvline(cue_out, linewidth=2.0, linestyle="--", label="Cue out")
        self.ax.set_ylim(-1.05, 1.05)
        self.ax.set_xlabel("Source-track time (seconds)")
        self.ax.set_ylabel("Peak amplitude")
        self.ax.set_title(f"{track.filename} — drag cue-in and cue-out lines")
        self.ax.legend(loc="upper right")
        if old_xlim and preserve_xlim:
            self.ax.set_xlim(old_xlim)
        else:
            self.ax.set_xlim(0, max(track.duration_s or float(times[-1]), 1.0))
        self.figure.tight_layout()
        self.canvas.draw_idle()

    def fit_waveform(self) -> None:
        track = self.selected_track()
        if self.ax is None or self.canvas is None or not track:
            return
        self.ax.set_xlim(0, max(track.duration_s or 1.0, 1.0))
        self.canvas.draw_idle()

    def _nearest_beat(self, track: TrackInfo, value: float) -> float:
        if not track.beat_times_s:
            return value
        return min(track.beat_times_s, key=lambda beat: abs(beat - value))

    def _line_hit(self, event_x_pixels: float, line, tolerance_pixels: float = 10.0) -> bool:
        if self.ax is None or line is None:
            return False
        line_x = float(np.asarray(line.get_xdata()).reshape(-1)[0])
        rendered_x = float(self.ax.transData.transform((line_x, 0.0))[0])
        return abs(event_x_pixels - rendered_x) <= tolerance_pixels

    def on_waveform_press(self, event) -> None:
        if event.button != 1 or event.inaxes != self.ax or event.xdata is None:
            return
        if self._line_hit(event.x, self.cue_in_line):
            self.dragging_cue = "cue_in"
        elif self._line_hit(event.x, self.cue_out_line):
            self.dragging_cue = "cue_out"

    def on_waveform_motion(self, event) -> None:
        if not self.dragging_cue or event.inaxes != self.ax or event.xdata is None or self.canvas is None:
            return
        track = self.selected_track()
        if not track:
            return
        duration = track.duration_s or max(float(event.xdata), 0.0)
        value = max(0.0, min(float(event.xdata), duration))
        cue_out = track.effective_cue_out_s if track.effective_cue_out_s is not None else duration
        if self.dragging_cue == "cue_in":
            value = min(value, cue_out - 0.01)
            self.cue_in_line.set_xdata([value, value])
        else:
            value = max(value, track.cue_in_s + 0.01)
            self.cue_out_line.set_xdata([value, value])
        self.canvas.draw_idle()

    def on_waveform_release(self, event) -> None:
        if not self.dragging_cue:
            return
        track = self.selected_track()
        if not track:
            self.dragging_cue = None
            return
        line = self.cue_in_line if self.dragging_cue == "cue_in" else self.cue_out_line
        value = float(np.asarray(line.get_xdata()).reshape(-1)[0])
        if self.snap_dragged_cues_var.get():
            value = self._nearest_beat(track, value)
        duration = track.duration_s or value
        if self.dragging_cue == "cue_in":
            cue_out = track.effective_cue_out_s if track.effective_cue_out_s is not None else duration
            track.cue_in_s = max(0.0, min(value, cue_out - 0.01))
        else:
            track.cue_out_s = min(duration, max(value, track.cue_in_s + 0.01))
        self.dragging_cue = None
        self.refresh_table(select_uid=track.uid)
        self.log(f"Updated draggable cue markers: {track.filename} | {track.cue_in_s:.3f}s → {track.effective_cue_out_s:.3f}s")

    def snap_selected_cues_to_beats(self) -> None:
        track = self.selected_track()
        if not track:
            return
        if not track.beat_times_s:
            messagebox.showinfo(APP_TITLE, "Analyse the track first; there are no detected beats to snap to.")
            return
        track.cue_in_s = self._nearest_beat(track, track.cue_in_s)
        cue_out = track.effective_cue_out_s if track.effective_cue_out_s is not None else (track.duration_s or 0.0)
        track.cue_out_s = self._nearest_beat(track, cue_out)
        if track.cue_out_s <= track.cue_in_s:
            later = [beat for beat in track.beat_times_s if beat > track.cue_in_s]
            track.cue_out_s = later[0] if later else track.duration_s
        self.refresh_table(select_uid=track.uid)
        self.log(f"Snapped cues to detected beats: {track.filename}")

    # ---------- add / order / remove ----------

    def add_tracks(self) -> None:
        paths = filedialog.askopenfilenames(title="Choose audio files", filetypes=SUPPORTED_AUDIO_TYPES)
        if not paths:
            return
        existing = {track.path.resolve() for track in self.tracks}
        added = 0
        for raw in paths:
            path = Path(raw)
            if path.resolve() not in existing:
                self.tracks.append(TrackInfo(path=path))
                existing.add(path.resolve())
                added += 1
        self.refresh_table(select_uid=self.tracks[-1].uid if self.tracks else None)
        self.log(f"Added {added} track(s).")

    def remove_selected(self) -> None:
        track = self.selected_track()
        if not track:
            return
        self.tracks = [item for item in self.tracks if item.uid != track.uid]
        self.refresh_table()
        self.log(f"Removed: {track.filename}")

    def move_selected(self, offset: int) -> None:
        track = self.selected_track()
        if not track:
            return
        index = self.tracks.index(track)
        new_index = max(0, min(len(self.tracks) - 1, index + offset))
        if new_index == index:
            return
        self.tracks[index], self.tracks[new_index] = self.tracks[new_index], self.tracks[index]
        self.refresh_table(select_uid=track.uid)

    # ---------- analysis ----------

    def analyse_selected(self) -> None:
        track = self.selected_track()
        if not track:
            messagebox.showinfo(APP_TITLE, "Select a track first.")
            return
        self.start_analysis([track])

    def analyse_all(self) -> None:
        if not self.tracks:
            messagebox.showinfo(APP_TITLE, "Add at least one audio file first.")
            return
        self.start_analysis(list(self.tracks))

    def start_analysis(self, tracks: list[TrackInfo]) -> None:
        if self.busy:
            messagebox.showwarning(APP_TITLE, "Another operation is already running.")
            return
        self.set_busy(True, "Analysing tracks…")
        self.progress["value"] = 0
        threading.Thread(target=self._analysis_worker, args=(tracks,), daemon=True).start()

    def _analysis_worker(self, tracks: list[TrackInfo]) -> None:
        failures = 0
        total = len(tracks)
        for index, track in enumerate(tracks, start=1):
            try:
                self.log_from_worker(f"Analysing: {track.filename}")
                track.status = "Analysing…"
                self.call_ui(self.refresh_table, track.uid)
                analyse_track(track)
                self.log_from_worker(
                    f"Analysed: {track.filename} | {format_number(track.estimated_bpm, 1)} BPM | "
                    f"{track.approx_key or 'key unavailable'} | {len(track.beat_times_s)} beats"
                )
            except Exception as exc:  # noqa: BLE001
                failures += 1
                track.status = "Analysis failed"
                self.log_from_worker(f"Analysis failed for {track.filename}: {exc}")
                self.log_from_worker(traceback.format_exc())
            self.call_ui(self.set_progress, index / total * 100.0, f"Analysed {index}/{total} track(s)")
            self.call_ui(self.refresh_table, track.uid)
        summary = f"Analysis complete: {total - failures} succeeded, {failures} failed."
        self.call_ui(self.set_busy, False, summary)
        self.log_from_worker(summary)

    # ---------- editable cues and BPM ----------

    def apply_selected_edits(self) -> None:
        track = self.selected_track()
        if not track:
            return
        try:
            cue_in = float(self.cue_in_var.get().strip())
            cue_out_raw = self.cue_out_var.get().strip()
            cue_out = float(cue_out_raw) if cue_out_raw else track.duration_s
            override_raw = self.bpm_override_var.get().strip()
            override = float(override_raw) if override_raw else None
        except ValueError:
            messagebox.showerror(APP_TITLE, "Cue points and BPM override must be numeric values.")
            return
        if cue_in < 0:
            messagebox.showerror(APP_TITLE, "Cue-in cannot be negative.")
            return
        if cue_out is not None and cue_out <= cue_in:
            messagebox.showerror(APP_TITLE, "Cue-out must be greater than cue-in.")
            return
        if track.duration_s is not None and cue_out is not None and cue_out > track.duration_s:
            messagebox.showerror(APP_TITLE, "Cue-out cannot be later than track duration.")
            return
        if override is not None and override <= 0:
            messagebox.showerror(APP_TITLE, "BPM override must be positive.")
            return
        track.cue_in_s = cue_in
        track.cue_out_s = cue_out
        track.bpm_override = override
        self.refresh_table(select_uid=track.uid)
        self.log(f"Updated cues/BPM: {track.filename}")

    def use_first_beat_as_cue_in(self) -> None:
        track = self.selected_track()
        if not track:
            return
        if track.first_beat_s is None:
            messagebox.showinfo(APP_TITLE, "Analyse the track first; no detected first beat is available.")
            return
        track.cue_in_s = track.first_beat_s
        self.refresh_table(select_uid=track.uid)
        self.log(f"Used first detected beat as cue-in: {track.filename}")

    def clear_bpm_override(self) -> None:
        track = self.selected_track()
        if not track:
            return
        track.bpm_override = None
        self.refresh_table(select_uid=track.uid)
        self.log(f"Cleared BPM override: {track.filename}")

    # ---------- settings and transition plan ----------

    def current_render_settings(self) -> RenderSettings:
        try:
            seconds = float(self.crossfade_seconds_var.get().strip())
            bars = float(self.crossfade_bars_var.get().strip())
            target_dbfs = float(self.target_dbfs_var.get().strip())
            fixed_target = float(self.fixed_target_bpm_var.get().strip())
            max_change = float(self.max_tempo_change_pct_var.get().strip())
        except ValueError as exc:
            raise ValueError("Crossfade, gain and tempo settings must be numeric.") from exc
        if seconds < 0 or bars < 0:
            raise ValueError("Crossfade values cannot be negative.")
        if fixed_target <= 0:
            raise ValueError("Fixed target BPM must be positive.")
        if max_change < 0:
            raise ValueError("Maximum tempo change cannot be negative.")
        return RenderSettings(
            crossfade_mode=self.crossfade_mode_var.get(),
            fixed_crossfade_seconds=seconds,
            crossfade_bars=bars,
            gain_match=bool(self.gain_match_var.get()),
            target_dbfs=target_dbfs,
            tempo_match=bool(self.tempo_match_var.get()),
            tempo_mode=self.tempo_mode_var.get(),
            fixed_target_bpm=fixed_target,
            max_tempo_change_pct=max_change,
            allow_half_double_correction=bool(self.allow_half_double_var.get()),
        )

    def safe_render_settings(self) -> RenderSettings | None:
        try:
            return self.current_render_settings()
        except ValueError:
            return None

    def tempo_plan(self) -> list[TempoPlanItem]:
        settings = self.current_render_settings()
        return build_tempo_plan(list(self.tracks), settings)

    def tempo_plan_for_uid(self, uid: str) -> TempoPlanItem | None:
        settings = self.safe_render_settings()
        if not settings:
            return None
        return next((item for item in build_tempo_plan(list(self.tracks), settings) if item.track_uid == uid), None)

    @staticmethod
    def calculate_crossfade_seconds(
        outgoing: TrackInfo,
        incoming: TrackInfo,
        outgoing_plan: TempoPlanItem,
        incoming_plan: TempoPlanItem,
        settings: RenderSettings,
    ) -> float:
        if settings.crossfade_mode == "seconds":
            return settings.fixed_crossfade_seconds
        bpms = [value for value in (outgoing_plan.output_bpm, incoming_plan.output_bpm) if value is not None and value > 0]
        if not bpms:
            bpms = [value for value in (outgoing.effective_bpm, incoming.effective_bpm) if value is not None and value > 0]
        if not bpms:
            return settings.fixed_crossfade_seconds
        reference_bpm = sum(bpms) / len(bpms)
        return settings.crossfade_bars * 4.0 * 60.0 / reference_bpm

    def refresh_transition_plan(self) -> None:
        if len(self.tracks) < 1:
            self.replace_text(self.transition_text, "Add tracks to generate the render plan.\n")
            return
        try:
            settings = self.current_render_settings()
            tempo_plan = build_tempo_plan(list(self.tracks), settings)
        except ValueError as exc:
            self.replace_text(self.transition_text, f"Invalid setting: {exc}\n")
            return
        lines = [
            "Tempo plan",
            "Cue points are source-time markers. Processed preview and export trim first, then apply optional offline time-stretch. "
            "With bar overlap and beat-snapped cues, the crossfade is a basic beat-grid-aligned overlap. It is not verified "
            "downbeat detection, phrase detection, syncopation analysis or live DJ correction.",
            "",
        ]
        for index, (track, item) in enumerate(zip(self.tracks, tempo_plan), start=1):
            lines += [
                f"Track {index}: {track.filename}",
                f"  Used source BPM: {format_number(item.source_bpm, 2)} | interpreted: {format_number(item.interpreted_source_bpm, 2)}",
                f"  Requested target: {format_number(item.requested_target_bpm, 2)} | expected output: {format_number(item.output_bpm, 2)}",
                f"  Stretch rate: {item.stretch_rate:.5f}× | {item.reason}",
            ]
            if index < len(self.tracks):
                incoming = self.tracks[index]
                incoming_plan = tempo_plan[index]
                overlap = self.calculate_crossfade_seconds(track, incoming, item, incoming_plan, settings)
                lines += [
                    f"  → Next overlap: {overlap:.2f}s ({settings.crossfade_mode})",
                    f"  → Approx. keys: {track.approx_key or '—'} → {incoming.approx_key or '—'}",
                ]
            lines.append("")
        self.replace_text(self.transition_text, "\n".join(lines))

    # ---------- preview ----------

    def _start_ffplay(self, command: list[str]) -> None:
        creationflags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        self.preview_process = subprocess.Popen(
            command,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=creationflags,
        )

    def preview_selected_source(self) -> None:
        track = self.selected_track()
        if not track:
            messagebox.showinfo(APP_TITLE, "Select a track first.")
            return
        ffplay = shutil.which("ffplay")
        if not ffplay:
            messagebox.showerror(APP_TITLE, "ffplay was not found on PATH. Install FFmpeg, then restart the app.")
            return
        self.stop_preview()
        command = [ffplay, "-nodisp", "-autoexit", "-loglevel", "quiet"]
        if track.cue_in_s > 0:
            command += ["-ss", f"{track.cue_in_s:.3f}"]
        if track.selected_duration_s is not None:
            command += ["-t", f"{track.selected_duration_s:.3f}"]
        command.append(str(track.path))
        try:
            self._start_ffplay(command)
            self.log(f"Previewing source region: {track.filename}")
        except OSError as exc:
            messagebox.showerror(APP_TITLE, f"Could not start preview: {exc}")

    def preview_selected_processed(self) -> None:
        track = self.selected_track()
        if not track:
            messagebox.showinfo(APP_TITLE, "Select a track first.")
            return
        if self.busy:
            messagebox.showwarning(APP_TITLE, "Another operation is already running.")
            return
        if not shutil.which("ffplay"):
            messagebox.showerror(APP_TITLE, "ffplay was not found on PATH. Install FFmpeg, then restart the app.")
            return
        try:
            settings = self.current_render_settings()
            plan = build_tempo_plan(list(self.tracks), settings)
            item = next(value for value in plan if value.track_uid == track.uid)
        except (ValueError, StopIteration) as exc:
            messagebox.showerror(APP_TITLE, f"Could not create processed preview plan: {exc}")
            return
        self.stop_preview()
        self.set_busy(True, "Rendering processed preview…")
        self.progress["value"] = 0
        threading.Thread(target=self._processed_preview_worker, args=(track, settings, item), daemon=True).start()

    def _processed_preview_worker(self, track: TrackInfo, settings: RenderSettings, item: TempoPlanItem) -> None:
        try:
            self.log_from_worker(f"Preparing processed preview: {track.filename}")
            self.call_ui(self.set_progress, 20.0, "Loading preview region…")
            segment = self._prepare_segment(track, settings, item)
            self.call_ui(self.set_progress, 75.0, "Writing temporary preview…")
            handle = tempfile.NamedTemporaryFile(prefix="djmix_preview_", suffix=".wav", delete=False)
            path = Path(handle.name)
            handle.close()
            segment.export(path, format="wav")
            self.call_ui(self._play_processed_preview_file, path, track.filename)
        except Exception as exc:  # noqa: BLE001
            self.log_from_worker(f"Processed preview failed: {exc}")
            self.log_from_worker(traceback.format_exc())
            self.call_ui(messagebox.showerror, APP_TITLE, f"Processed preview failed:\n{exc}")
            self.call_ui(self.set_busy, False, "Ready")

    def _play_processed_preview_file(self, path: Path, filename: str) -> None:
        ffplay = shutil.which("ffplay")
        if not ffplay:
            self.set_busy(False, "Ready")
            return
        self.preview_temp_path = path
        try:
            self._start_ffplay([ffplay, "-nodisp", "-autoexit", "-loglevel", "quiet", str(path)])
            self.set_progress(100.0, "Processed preview playing")
            self.set_busy(False, "Processed preview playing")
            self.log(f"Previewing processed region: {filename}")
        except OSError as exc:
            self.set_busy(False, "Ready")
            messagebox.showerror(APP_TITLE, f"Could not start processed preview: {exc}")

    def stop_preview(self) -> None:
        if self.preview_process and self.preview_process.poll() is None:
            self.preview_process.terminate()
            try:
                self.preview_process.wait(timeout=1.0)
            except subprocess.TimeoutExpired:
                self.preview_process.kill()
        self.preview_process = None
        if self.preview_temp_path:
            try:
                self.preview_temp_path.unlink(missing_ok=True)
            except OSError:
                pass
            self.preview_temp_path = None

    # ---------- render ----------

    def export_mix(self) -> None:
        if self.busy:
            messagebox.showwarning(APP_TITLE, "Another operation is already running.")
            return
        if not self.tracks:
            messagebox.showinfo(APP_TITLE, "Add at least one audio file first.")
            return
        output = filedialog.asksaveasfilename(
            title="Export mixed set", defaultextension=".mp3", filetypes=(("MP3 file", "*.mp3"), ("WAV file", "*.wav"))
        )
        if not output:
            return
        try:
            settings = self.current_render_settings()
            tempo_plan = build_tempo_plan(list(self.tracks), settings)
        except ValueError as exc:
            messagebox.showerror(APP_TITLE, str(exc))
            return
        self.stop_preview()
        self.set_busy(True, "Rendering mix…")
        self.progress["value"] = 0
        threading.Thread(target=self._render_worker, args=(Path(output), settings, tempo_plan), daemon=True).start()

    def _trim_source_segment(self, track: TrackInfo) -> AudioSegment:
        segment = (
            AudioSegment.from_file(track.path)
            .set_channels(2)
            .set_frame_rate(DEFAULT_SAMPLE_RATE)
            .set_sample_width(2)
        )
        start_ms = max(0, int(round(track.cue_in_s * 1000.0)))
        end_s = track.effective_cue_out_s
        end_ms = len(segment) if end_s is None else min(len(segment), int(round(end_s * 1000.0)))
        if end_ms <= start_ms:
            raise ValueError(f"Invalid cue region for {track.filename}: cue-out must follow cue-in.")
        return segment[start_ms:end_ms]

    def _prepare_segment(self, track: TrackInfo, settings: RenderSettings, tempo_item: TempoPlanItem) -> AudioSegment:
        segment = self._trim_source_segment(track)
        if tempo_item.apply_stretch:
            self.log_from_worker(
                f"Time-stretching {track.filename}: {tempo_item.stretch_rate:.5f}× "
                f"({format_number(tempo_item.interpreted_source_bpm, 2)} → {format_number(tempo_item.output_bpm, 2)} BPM)"
            )
            segment = time_stretch_segment(segment, tempo_item.stretch_rate)
        if settings.gain_match:
            segment = apply_simple_gain_matching(segment, settings.target_dbfs)
        return segment

    def _render_worker(self, output_path: Path, settings: RenderSettings, tempo_plan: list[TempoPlanItem]) -> None:
        try:
            tracks = list(self.tracks)
            plan_by_uid = {item.track_uid: item for item in tempo_plan}
            total_steps = max(1, len(tracks) + max(0, len(tracks) - 1) + 1)
            completed = 0
            prepared: list[tuple[TrackInfo, TempoPlanItem, AudioSegment]] = []
            self.log_from_worker("Starting mix render…")
            for track in tracks:
                item = plan_by_uid[track.uid]
                self.log_from_worker(f"Preparing: {track.filename} | {item.reason}")
                segment = self._prepare_segment(track, settings, item)
                prepared.append((track, item, segment))
                completed += 1
                self.call_ui(self.set_progress, completed / total_steps * 100.0, f"Prepared {completed}/{len(tracks)} track(s)")

            outgoing_track, outgoing_plan, mix = prepared[0]
            for incoming_track, incoming_plan, incoming_segment in prepared[1:]:
                overlap_s = self.calculate_crossfade_seconds(outgoing_track, incoming_track, outgoing_plan, incoming_plan, settings)
                requested_ms = int(round(overlap_s * 1000.0))
                safe_ms = max(0, min(requested_ms, len(mix), len(incoming_segment)))
                self.log_from_worker(
                    f"Crossfading: {outgoing_track.filename} → {incoming_track.filename} | {safe_ms / 1000.0:.2f}s overlap"
                )
                mix = mix.append(incoming_segment, crossfade=safe_ms)
                outgoing_track, outgoing_plan = incoming_track, incoming_plan
                completed += 1
                self.call_ui(self.set_progress, completed / total_steps * 100.0, "Rendering crossfades…")

            output_path.parent.mkdir(parents=True, exist_ok=True)
            if output_path.suffix.lower() == ".wav":
                mix.export(output_path, format="wav")
            else:
                mix.export(output_path, format="mp3", bitrate="320k")
            completed += 1
            self.call_ui(self.set_progress, completed / total_steps * 100.0, "Mix export complete")
            self.log_from_worker(f"Saved mix: {output_path}")
            self.call_ui(messagebox.showinfo, APP_TITLE, f"Mix export complete:\n{output_path}")
        except Exception as exc:  # noqa: BLE001
            self.log_from_worker(f"Render failed: {exc}")
            self.log_from_worker(traceback.format_exc())
            self.call_ui(messagebox.showerror, APP_TITLE, f"Mix export failed:\n{exc}")
        finally:
            self.call_ui(self.set_busy, False, "Ready")

    # ---------- CSV ----------

    def export_analysis_csv(self) -> None:
        if not self.tracks:
            messagebox.showinfo(APP_TITLE, "Add tracks first.")
            return
        output = filedialog.asksaveasfilename(title="Export track analysis", defaultextension=".csv", filetypes=(("CSV file", "*.csv"),))
        if not output:
            return
        settings = self.safe_render_settings()
        plan_by_uid = {item.track_uid: item for item in build_tempo_plan(list(self.tracks), settings)} if settings else {}
        fieldnames = [
            "order", "file", "path", "duration_seconds", "estimated_bpm", "manual_bpm_override", "planning_bpm",
            "interpreted_source_bpm", "requested_target_bpm", "expected_rendered_bpm", "stretch_rate", "stretch_action",
            "detected_beats", "estimated_4_4_bars", "median_beat_interval_seconds", "first_detected_beat_seconds",
            "approximate_global_key", "average_dbfs", "peak_dbfs", "sample_rate_hz", "channels", "cue_in_seconds",
            "cue_out_seconds", "status"
        ]
        with open(output, "w", newline="", encoding="utf-8-sig") as handle:
            writer = csv.DictWriter(handle, fieldnames=fieldnames)
            writer.writeheader()
            for index, track in enumerate(self.tracks, start=1):
                item = plan_by_uid.get(track.uid)
                writer.writerow({
                    "order": index, "file": track.filename, "path": str(track.path), "duration_seconds": track.duration_s,
                    "estimated_bpm": track.estimated_bpm, "manual_bpm_override": track.bpm_override, "planning_bpm": track.effective_bpm,
                    "interpreted_source_bpm": item.interpreted_source_bpm if item else None,
                    "requested_target_bpm": item.requested_target_bpm if item else None,
                    "expected_rendered_bpm": item.output_bpm if item else None,
                    "stretch_rate": item.stretch_rate if item else None,
                    "stretch_action": item.reason if item else None,
                    "detected_beats": len(track.beat_times_s), "estimated_4_4_bars": track.estimated_bars_4_4,
                    "median_beat_interval_seconds": track.median_beat_interval_s, "first_detected_beat_seconds": track.first_beat_s,
                    "approximate_global_key": track.approx_key, "average_dbfs": track.avg_dbfs, "peak_dbfs": track.peak_dbfs,
                    "sample_rate_hz": track.sample_rate, "channels": track.channels, "cue_in_seconds": track.cue_in_s,
                    "cue_out_seconds": track.effective_cue_out_s, "status": track.status,
                })
        self.log(f"Saved analysis CSV: {output}")
        messagebox.showinfo(APP_TITLE, f"Analysis CSV saved:\n{output}")

    # ---------- shutdown ----------

    def on_close(self) -> None:
        self.stop_preview()
        self.root.destroy()


def main() -> None:
    root = tk.Tk()
    DJMixerApp(root)
    root.mainloop()


if __name__ == "__main__":
    main()
