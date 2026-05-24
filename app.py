import os
import glob as _glob
import shutil
import subprocess
import threading
import uuid
from datetime import datetime

# Ensure FFmpeg is findable even when WinGet symlink is broken
_winget_ffmpeg = _glob.glob(
    os.path.expandvars(r"%LOCALAPPDATA%\Microsoft\WinGet\Packages\Gyan.FFmpeg*\*\bin")
)
if _winget_ffmpeg:
    os.environ["PATH"] = _winget_ffmpeg[0] + os.pathsep + os.environ.get("PATH", "")

from flask import Flask, request, jsonify, render_template, send_from_directory
from werkzeug.utils import secure_filename
import cutter

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
OUTPUT_DIR = os.path.join(BASE_DIR, "output")
UPLOAD_DIR = os.path.join(BASE_DIR, "uploads")

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 4 * 1024 * 1024 * 1024  # 4GB

os.makedirs(OUTPUT_DIR, exist_ok=True)
os.makedirs(UPLOAD_DIR, exist_ok=True)

JOBS: dict[str, dict] = {}
JOB_PAYLOADS: dict[str, dict] = {}
JOB_QUEUE: list[str] = []
JOB_HISTORY: list[dict] = []
MAX_HISTORY_ITEMS = 12
JOB_LOCK = threading.Lock()
QUEUE_CONDITION = threading.Condition(JOB_LOCK)
QUEUE_WORKER_STARTED = False


def _metadata_to_dict(metadata: cutter.VideoMetadata) -> dict:
    return {
        "duration_seconds": metadata.duration_seconds,
        "duration_display": metadata.duration_display,
        "size_bytes": metadata.size_bytes,
        "bitrate_bps": metadata.bitrate_bps,
    }


def _get_input_metadata(input_path: str) -> cutter.VideoMetadata:
    return cutter.probe_video(input_path)


def _safe_size(path: str) -> int:
    try:
        return os.path.getsize(path)
    except OSError:
        return 0


def _append_history(item: dict) -> None:
    JOB_HISTORY.insert(
        0,
        {
            "completed_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            **item,
        },
    )
    del JOB_HISTORY[MAX_HISTORY_ITEMS:]


def _now_display() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _refresh_queue_positions_locked() -> None:
    for position, queued_job_id in enumerate(JOB_QUEUE, start=1):
        if queued_job_id in JOBS:
            JOBS[queued_job_id]["queue_position"] = position


def _enqueue_job(job_id: str, payload: dict) -> None:
    global QUEUE_WORKER_STARTED
    with QUEUE_CONDITION:
        JOB_PAYLOADS[job_id] = payload
        JOB_QUEUE.append(job_id)
        _refresh_queue_positions_locked()
        if not QUEUE_WORKER_STARTED:
            worker = threading.Thread(target=_queue_worker, daemon=True)
            worker.start()
            QUEUE_WORKER_STARTED = True
        QUEUE_CONDITION.notify()


def _queue_worker() -> None:
    while True:
        with QUEUE_CONDITION:
            while not JOB_QUEUE:
                QUEUE_CONDITION.wait()
            job_id = JOB_QUEUE.pop(0)
            _refresh_queue_positions_locked()
            job = JOBS.get(job_id)
            payload = JOB_PAYLOADS.get(job_id)
            if not job or not payload:
                continue
            job["status"] = "running"
            job["queue_position"] = 0
            job["started_at"] = _now_display()
            job["message"] = "Starting"

        try:
            if payload["type"] == "cut":
                _run_cut_job(job_id, payload["flat_parts"])
            elif payload["type"] == "compress":
                _run_compress_job(job_id, payload["metadata"])
        except Exception as exc:
            with JOB_LOCK:
                failed_job = JOBS.get(job_id)
                if failed_job:
                    failed_job["status"] = "failed"
                    failed_job["message"] = str(exc)
                    failed_job["completed_at"] = _now_display()
        finally:
            with JOB_LOCK:
                JOB_PAYLOADS.pop(job_id, None)


def _public_job(job: dict) -> dict:
    output_files = list(job.get("created_files") or [])
    output_size_bytes = job.get("output_size_bytes")
    if output_size_bytes is None and output_files:
        output_size_bytes = sum(
            _safe_size(os.path.join(OUTPUT_DIR, name)) for name in output_files
        )
    return {
        "job_id": job.get("job_id"),
        "type": job.get("type"),
        "tool_label": job.get("tool_label"),
        "source_file": job.get("source_file") or os.path.basename(job.get("input_path", "")),
        "status": job.get("status"),
        "message": job.get("message"),
        "progress_percent": job.get("progress_percent", 0),
        "queue_position": job.get("queue_position", 0),
        "created_at": job.get("created_at"),
        "started_at": job.get("started_at"),
        "completed_at": job.get("completed_at"),
        "current_segment_name": job.get("current_segment_name"),
        "current_slice_percent": job.get("current_slice_percent", 0),
        "current_slice_index": job.get("current_slice_index", 0),
        "completed_parts": job.get("completed_parts", 0),
        "total_parts": job.get("total_parts", 0),
        "source_size_bytes": job.get("source_size_bytes"),
        "output_size_bytes": output_size_bytes,
        "output_files": output_files,
        "result": job.get("result"),
        "results": job.get("results", []),
    }


def _delete_files_in_dir(folder: str, extensions: tuple[str, ...] | None = None) -> dict:
    deleted = 0
    skipped = []
    for name in os.listdir(folder):
        if extensions and not name.lower().endswith(extensions):
            continue
        path = os.path.join(folder, name)
        if not os.path.isfile(path):
            continue
        try:
            os.remove(path)
            deleted += 1
        except PermissionError:
            skipped.append({"name": name, "reason": "File is in use by another process"})
        except OSError as exc:
            skipped.append({"name": name, "reason": str(exc)})
    return {"deleted": deleted, "skipped": skipped}


def _build_plan(input_path: str, segments: list[dict]) -> tuple[cutter.VideoMetadata, list[dict]]:
    metadata = _get_input_metadata(input_path)
    planned_segments = cutter.plan_segments(segments, metadata)
    return metadata, planned_segments


def _create_job(input_path: str, planned_segments: list[dict]) -> str:
    total_parts = sum(len(segment["parts"]) for segment in planned_segments)
    flat_parts = []
    for segment in planned_segments:
        for part in segment["parts"]:
            flat_parts.append(
                {
                    "segment_name": segment["name"],
                    **part,
                }
            )

    job_id = uuid.uuid4().hex
    with JOB_LOCK:
        JOBS[job_id] = {
            "job_id": job_id,
            "type": "cut",
            "tool_label": "Cut Video",
            "source_file": os.path.basename(input_path),
            "input_path": input_path,
            "status": "queued",
            "message": "Queued",
            "progress_percent": 0.0,
            "queue_position": 0,
            "created_at": _now_display(),
            "started_at": None,
            "completed_at": None,
            "current_segment_name": None,
            "current_slice_percent": 0.0,
            "current_slice_index": 0,
            "completed_parts": 0,
            "total_parts": total_parts,
            "results": [],
            "planned_segments": planned_segments,
            "created_files": [],
        }

    _enqueue_job(job_id, {"type": "cut", "flat_parts": flat_parts})
    return job_id


def _create_compress_job(input_path: str, crf: int) -> str:
    metadata = _get_input_metadata(input_path)
    job_id = uuid.uuid4().hex
    with JOB_LOCK:
        JOBS[job_id] = {
            "job_id": job_id,
            "type": "compress",
            "tool_label": "Compress Video",
            "source_file": os.path.basename(input_path),
            "input_path": input_path,
            "status": "queued",
            "message": "Queued",
            "progress_percent": 0.0,
            "queue_position": 0,
            "created_at": _now_display(),
            "started_at": None,
            "completed_at": None,
            "result": None,
            "created_files": [],
            "source_size_bytes": metadata.size_bytes,
            "output_size_bytes": None,
            "crf": crf,
        }

    _enqueue_job(job_id, {"type": "compress", "metadata": metadata})
    return job_id


def _run_cut_job(job_id: str, flat_parts: list[dict]) -> None:
    for index, part in enumerate(flat_parts):
        with JOB_LOCK:
            job = JOBS.get(job_id)
            if not job:
                return
            job["status"] = "running"
            job["current_segment_name"] = part["name"]
            job["current_slice_index"] = index + 1
            job["current_slice_percent"] = 0.0
            job["message"] = f"Preparing {part['name']}"

        output_path = cutter.make_output_path(OUTPUT_DIR, part["name"])

        def report_progress(part_percent: float, message: str) -> None:
            overall = ((index + (part_percent / 100.0)) / len(flat_parts)) * 100
            with JOB_LOCK:
                current_job = JOBS.get(job_id)
                if not current_job:
                    return
                current_job["status"] = "running"
                current_job["progress_percent"] = round(overall, 1)
                current_job["current_segment_name"] = part["name"]
                current_job["current_slice_percent"] = round(part_percent, 1)
                current_job["current_slice_index"] = index + 1
                current_job["message"] = message

        result = cutter.cut_segment(
            job["input_path"],
            part["start"],
            part["end"],
            output_path,
            progress_callback=report_progress,
        )

        with JOB_LOCK:
            current_job = JOBS.get(job_id)
            if not current_job:
                return
            current_job["results"].append(
                {
                    "name": part["name"],
                    "segment_name": part["segment_name"],
                    "start": part["start"],
                    "end": part["end"],
                    **result,
                }
            )
            current_job["completed_parts"] = index + 1
            current_job["progress_percent"] = round(((index + 1) / len(flat_parts)) * 100, 1)
            current_job["current_slice_percent"] = 100.0
            if result["success"] and result["output_file"]:
                current_job["created_files"].append(result["output_file"])
            if not result["success"]:
                current_job["status"] = "failed"
                current_job["message"] = result.get("stderr") or f"Failed while cutting {part['name']}"
                current_job["current_segment_name"] = part["name"]
                current_job["completed_at"] = _now_display()
                return

    with JOB_LOCK:
        job = JOBS.get(job_id)
        if not job:
            return
        job["status"] = "completed"
        job["message"] = "All segments completed"
        job["current_segment_name"] = None
        job["progress_percent"] = 100.0
        job["current_slice_percent"] = 100.0
        job["completed_at"] = _now_display()
        _append_history(
            {
                "type": "cut",
                "source_file": os.path.basename(job["input_path"]),
                "status": "completed",
                "output_files": list(job["created_files"]),
                "output_count": len(job["created_files"]),
                "output_size_bytes": sum(
                    _safe_size(os.path.join(OUTPUT_DIR, name))
                    for name in job["created_files"]
                ),
            }
        )


def _run_compress_job(job_id: str, metadata: cutter.VideoMetadata) -> None:
    with JOB_LOCK:
        job = JOBS.get(job_id)
        if not job:
            return
        job["status"] = "running"
        job["message"] = "Preparing compression"
        input_path = job["input_path"]
        crf = job["crf"]

    source_name = os.path.splitext(os.path.basename(input_path))[0]
    output_path = cutter.make_output_path(OUTPUT_DIR, f"{source_name}_compressed")

    def report_progress(percent: float, message: str) -> None:
        with JOB_LOCK:
            current_job = JOBS.get(job_id)
            if not current_job:
                return
            current_job["status"] = "running"
            current_job["progress_percent"] = round(percent, 1)
            current_job["message"] = message

    result = cutter.compress_video(
        input_path,
        output_path,
        metadata.duration_seconds,
        crf=crf,
        progress_callback=report_progress,
    )

    with JOB_LOCK:
        job = JOBS.get(job_id)
        if not job:
            return
        job["result"] = result
        if result["success"] and result["output_file"]:
            output_file_path = os.path.join(OUTPUT_DIR, result["output_file"])
            job["created_files"].append(result["output_file"])
            job["output_size_bytes"] = os.path.getsize(output_file_path)
            job["status"] = "completed"
            job["message"] = "Compression completed"
            job["progress_percent"] = 100.0
            job["completed_at"] = _now_display()
            _append_history(
                {
                    "type": "compress",
                    "source_file": os.path.basename(input_path),
                    "status": "completed",
                    "output_files": [result["output_file"]],
                    "output_count": 1,
                    "source_size_bytes": metadata.size_bytes,
                    "output_size_bytes": job["output_size_bytes"],
                    "crf": crf,
                }
            )
        else:
            job["status"] = "failed"
            job["message"] = result.get("stderr") or "Compression failed"
            job["completed_at"] = _now_display()


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/cut-video")
def cut_video_page():
    return render_template("cut_video.html")


@app.route("/compress-video")
def compress_video_page():
    return render_template("compress_video.html")


@app.route("/upload", methods=["POST"])
def upload():
    if "video" not in request.files:
        return jsonify({"error": "No file provided"}), 400
    f = request.files["video"]
    if not f.filename:
        return jsonify({"error": "Empty filename"}), 400
    filename = secure_filename(f.filename) or "video.mp4"
    save_path = os.path.join(UPLOAD_DIR, filename)
    f.save(save_path)
    try:
        metadata = _get_input_metadata(save_path)
    except Exception as exc:
        return jsonify({"saved_path": save_path, "probe_error": str(exc)})
    return jsonify({"saved_path": save_path, "file_name": filename, "metadata": _metadata_to_dict(metadata)})


@app.route("/system-status")
def system_status():
    ffmpeg_ready = True
    ffmpeg_error = None
    try:
        cutter.check_ffmpeg()
    except EnvironmentError as exc:
        ffmpeg_ready = False
        ffmpeg_error = str(exc)
    usage = shutil.disk_usage(OUTPUT_DIR)
    return jsonify(
        {
            "ffmpeg_ready": ffmpeg_ready,
            "ffmpeg_error": ffmpeg_error,
            "output_dir": OUTPUT_DIR,
            "uploads_dir": UPLOAD_DIR,
            "disk_free_bytes": usage.free,
            "disk_total_bytes": usage.total,
            "output_writable": os.access(OUTPUT_DIR, os.W_OK),
        }
    )


@app.route("/probe", methods=["POST"])
def probe():
    data = request.get_json()
    if not data or "input_path" not in data:
        return jsonify({"error": "Missing input_path"}), 400

    input_path = data["input_path"].strip()
    if not input_path:
        return jsonify({"error": "input_path cannot be empty"}), 400

    try:
        metadata = _get_input_metadata(input_path)
    except FileNotFoundError as exc:
        return jsonify({"error": str(exc)}), 404
    except Exception as exc:
        return jsonify({"error": str(exc)}), 400

    return jsonify({"input_path": input_path, "metadata": _metadata_to_dict(metadata)})


@app.route("/cut", methods=["POST"])
def cut():
    data = request.get_json()
    if not data or "input_path" not in data or "segments" not in data:
        return jsonify({"error": "Missing input_path or segments"}), 400

    input_path = data["input_path"]
    segments = data["segments"]

    if not isinstance(segments, list) or len(segments) == 0:
        return jsonify({"error": "segments must be a non-empty array"}), 400

    try:
        metadata, planned_segments = _build_plan(input_path, segments)
    except FileNotFoundError as exc:
        return jsonify({"error": str(exc)}), 404
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        return jsonify({"error": str(exc)}), 400

    job_id = _create_job(input_path, planned_segments)
    return jsonify(
        {
            "job_id": job_id,
            "metadata": _metadata_to_dict(metadata),
            "planned_segments": planned_segments,
        }
    )


@app.route("/compress", methods=["POST"])
def compress():
    data = request.get_json()
    if not data or "input_path" not in data:
        return jsonify({"error": "Missing input_path"}), 400

    input_path = data["input_path"]
    crf = data.get("crf", cutter.DEFAULT_COMPRESS_CRF)

    try:
        crf = cutter.validate_compression_crf(crf)
        metadata = _get_input_metadata(input_path)
    except FileNotFoundError as exc:
        return jsonify({"error": str(exc)}), 404
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        return jsonify({"error": str(exc)}), 400

    job_id = _create_compress_job(input_path, crf)
    return jsonify(
        {
            "job_id": job_id,
            "metadata": _metadata_to_dict(metadata),
            "crf": crf,
        }
    )


@app.route("/cut-status/<job_id>")
def cut_status(job_id):
    with JOB_LOCK:
        job = JOBS.get(job_id)
        if not job:
            return jsonify({"error": "Job not found"}), 404
        payload = dict(job)

    return jsonify(payload)


@app.route("/compress-status/<job_id>")
def compress_status(job_id):
    with JOB_LOCK:
        job = JOBS.get(job_id)
        if not job or job.get("type") != "compress":
            return jsonify({"error": "Job not found"}), 404
        payload = dict(job)

    return jsonify(payload)


@app.route("/jobs")
def jobs():
    with JOB_LOCK:
        jobs_list = [_public_job(job) for job in JOBS.values()]

    status_order = {"running": 0, "queued": 1, "failed": 2, "completed": 3}
    jobs_list.sort(
        key=lambda job: (
            status_order.get(job["status"], 4),
            job.get("queue_position") or 0,
            job.get("created_at") or "",
        )
    )
    return jsonify(jobs_list)


@app.route("/outputs")
def outputs():
    files = []
    for name in sorted(f for f in os.listdir(OUTPUT_DIR) if f.endswith(".mp4")):
        path = os.path.join(OUTPUT_DIR, name)
        files.append(
            {
                "name": name,
                "size_bytes": os.path.getsize(path),
            }
        )
    return jsonify(files)


@app.route("/job-history")
def job_history():
    with JOB_LOCK:
        return jsonify(list(JOB_HISTORY))


@app.route("/open-output-folder", methods=["POST"])
def open_output_folder():
    try:
        if hasattr(os, "startfile"):
            os.startfile(OUTPUT_DIR)  # type: ignore[attr-defined]
        elif shutil.which("open"):
            subprocess.Popen(["open", OUTPUT_DIR])
        elif os.name == "posix":
            subprocess.Popen(["xdg-open", OUTPUT_DIR])
        else:
            return jsonify({"error": "Opening folders is not supported on this OS"}), 400
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500
    return jsonify({"opened": True, "path": OUTPUT_DIR})


@app.route("/clear-outputs", methods=["POST"])
def clear_outputs():
    return jsonify(_delete_files_in_dir(OUTPUT_DIR, (".mp4",)))


@app.route("/clear-uploads", methods=["POST"])
def clear_uploads():
    return jsonify(
        _delete_files_in_dir(
            UPLOAD_DIR,
            (".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"),
        )
    )


@app.route("/download/<filename>")
def download(filename):
    if ".." in filename or "/" in filename or "\\" in filename:
        return jsonify({"error": "Invalid filename"}), 400
    return send_from_directory(OUTPUT_DIR, filename, as_attachment=True)


if __name__ == "__main__":
    try:
        cutter.check_ffmpeg()
    except EnvironmentError as e:
        print(f"WARNING: {e}")
    port = int(os.environ.get("PORT", "5000"))
    app.run(debug=True, port=port, use_reloader=False)
