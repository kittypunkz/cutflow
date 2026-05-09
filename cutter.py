import os
import re
import shutil
import subprocess
from dataclasses import dataclass
from datetime import datetime
from typing import Callable, Optional


def check_ffmpeg():
    if not shutil.which("ffmpeg"):
        raise EnvironmentError(
            "FFmpeg not found on PATH. Install with: winget install Gyan.FFmpeg"
        )
    if not shutil.which("ffprobe"):
        raise EnvironmentError(
            "FFprobe not found on PATH. Install with: winget install Gyan.FFmpeg"
        )


TIME_PATTERN = re.compile(r"^\d{2}:\d{2}:\d{2}$")
PROGRESS_TIME_PATTERN = re.compile(r"out_time_ms=(\d+)")


@dataclass
class VideoMetadata:
    duration_seconds: float
    duration_display: str
    size_bytes: int
    bitrate_bps: int


def parse_time_to_seconds(value: str) -> int:
    if not TIME_PATTERN.match(value):
        raise ValueError(f"Invalid time: {value}. Use HH:MM:SS")
    hours, minutes, seconds = (int(part) for part in value.split(":"))
    return hours * 3600 + minutes * 60 + seconds


def seconds_to_timecode(total_seconds: float) -> str:
    total_seconds = max(0, int(total_seconds))
    hours = total_seconds // 3600
    minutes = (total_seconds % 3600) // 60
    seconds = total_seconds % 60
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}"


def _safe_int(value: Optional[str], default: int = 0) -> int:
    try:
        return int(float(value or 0))
    except (TypeError, ValueError):
        return default


def _estimate_source_bitrate(size_bytes: int, duration_seconds: float) -> int:
    if duration_seconds <= 0:
        return 0
    estimated = int((size_bytes * 8) / duration_seconds)
    return max(0, estimated)


def probe_video(input_path: str) -> VideoMetadata:
    if not os.path.exists(input_path):
        raise FileNotFoundError(f"Input file not found: {input_path}")

    cmd = [
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "format=duration,size,bit_rate",
        "-of",
        "default=noprint_wrappers=1:nokey=0",
        input_path,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "ffprobe failed")

    data = {}
    for line in result.stdout.splitlines():
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        data[key.strip()] = value.strip()

    duration_seconds = float(data.get("duration") or 0)
    size_bytes = _safe_int(data.get("size"), default=os.path.getsize(input_path))
    bitrate_bps = _safe_int(data.get("bit_rate")) or _estimate_source_bitrate(
        size_bytes,
        duration_seconds,
    )

    return VideoMetadata(
        duration_seconds=duration_seconds,
        duration_display=seconds_to_timecode(duration_seconds),
        size_bytes=size_bytes,
        bitrate_bps=bitrate_bps,
    )


def plan_segments(
    segments: list[dict],
    metadata: VideoMetadata,
) -> list[dict]:
    planned_segments = []
    for seg in segments:
        name = (seg.get("name") or "clip").strip() or "clip"
        start = seg.get("start", "")
        end = seg.get("end", "")
        try:
            split_count = int(seg.get("split_count", 1))
        except (TypeError, ValueError):
            raise ValueError(f'"{name}": files must be a whole number.')
        if split_count < 1:
            raise ValueError(f'"{name}": files must be 1 or more.')

        start_seconds = parse_time_to_seconds(start)
        end_seconds = parse_time_to_seconds(end)
        if end_seconds <= start_seconds:
            raise ValueError(f'"{name}": end time must be after start time.')

        segment_seconds = end_seconds - start_seconds
        parts = []
        if split_count == 1:
            parts.append(
                {
                    "name": name,
                    "start": start,
                    "end": end,
                    "duration_seconds": segment_seconds,
                }
            )
        else:
            part_length = segment_seconds / split_count
            current = start_seconds
            for index in range(1, split_count + 1):
                if index == split_count:
                    part_end = end_seconds
                else:
                    part_end = start_seconds + round(part_length * index)
                parts.append(
                    {
                        "name": f"{name}_part{index}",
                        "start": seconds_to_timecode(current),
                        "end": seconds_to_timecode(part_end),
                        "duration_seconds": part_end - current,
                    }
                )
                current = part_end

        planned_segments.append(
            {
                "name": name,
                "start": start,
                "end": end,
                "duration_seconds": segment_seconds,
                "split_count": split_count,
                "split": split_count > 1,
                "parts": parts,
            }
        )
    return planned_segments


def cut_segment(
    input_path: str,
    start: str,
    end: str,
    output_path: str,
    progress_callback: Optional[Callable[[float, str], None]] = None,
) -> dict:
    if not os.path.exists(input_path):
        return {"success": False, "output_file": None, "stderr": f"Input file not found: {input_path}"}

    try:
        start_seconds = parse_time_to_seconds(start)
    except ValueError:
        return {"success": False, "output_file": None, "stderr": f"Invalid start time: {start}. Use HH:MM:SS"}

    try:
        end_seconds = parse_time_to_seconds(end)
    except ValueError:
        return {"success": False, "output_file": None, "stderr": f"Invalid end time: {end}. Use HH:MM:SS"}

    clip_duration = end_seconds - start_seconds
    if clip_duration <= 0:
        return {"success": False, "output_file": None, "stderr": "End time must be after start time"}

    os.makedirs(os.path.dirname(output_path), exist_ok=True)

    cmd = [
        "ffmpeg", "-y", "-loglevel", "error", "-i", input_path,
        "-ss", start, "-to", end,
        "-c:v", "libx264", "-crf", "23", "-preset", "fast",
        "-c:a", "aac", "-b:a", "128k",
        "-progress", "pipe:1",
        "-nostats",
        output_path,
    ]

    try:
        process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
    except FileNotFoundError:
        return {"success": False, "output_file": None, "stderr": "FFmpeg not found. Install with: winget install Gyan.FFmpeg"}

    try:
        assert process.stdout is not None
        for line in process.stdout:
            match = PROGRESS_TIME_PATTERN.search(line.strip())
            if match and progress_callback:
                out_time_seconds = int(match.group(1)) / 1_000_000
                percent = min(100.0, (out_time_seconds / clip_duration) * 100)
                progress_callback(percent, f"Cutting {seconds_to_timecode(out_time_seconds)} / {end}")
        _, stderr = process.communicate(timeout=300)
    except subprocess.TimeoutExpired:
        process.kill()
        _, stderr = process.communicate()
        return {"success": False, "output_file": None, "stderr": "FFmpeg timed out after 5 minutes"}

    if process.returncode != 0:
        return {"success": False, "output_file": None, "stderr": stderr}

    if progress_callback:
        progress_callback(100.0, "Completed")

    return {"success": True, "output_file": os.path.basename(output_path), "stderr": stderr}


def make_output_path(output_dir: str, name: str) -> str:
    safe_name = re.sub(r"[^\w\-]", "_", name)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"{safe_name}_{timestamp}.mp4"
    return os.path.join(output_dir, filename)
