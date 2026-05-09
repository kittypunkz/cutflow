import os
import glob as _glob
import threading
import uuid

# Ensure FFmpeg is findable even when WinGet symlink is broken
_winget_ffmpeg = _glob.glob(
    os.path.expandvars(r"%LOCALAPPDATA%\Microsoft\WinGet\Packages\Gyan.FFmpeg*\*\bin")
)
if _winget_ffmpeg:
    os.environ["PATH"] = _winget_ffmpeg[0] + os.pathsep + os.environ.get("PATH", "")

from flask import Flask, request, jsonify, render_template, send_from_directory
import cutter

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
OUTPUT_DIR = os.path.join(BASE_DIR, "output")
UPLOAD_DIR = os.path.join(BASE_DIR, "uploads")

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 4 * 1024 * 1024 * 1024  # 4GB

os.makedirs(OUTPUT_DIR, exist_ok=True)
os.makedirs(UPLOAD_DIR, exist_ok=True)

JOBS: dict[str, dict] = {}
JOB_LOCK = threading.Lock()


def _metadata_to_dict(metadata: cutter.VideoMetadata) -> dict:
    return {
        "duration_seconds": metadata.duration_seconds,
        "duration_display": metadata.duration_display,
        "size_bytes": metadata.size_bytes,
        "bitrate_bps": metadata.bitrate_bps,
    }


def _get_input_metadata(input_path: str) -> cutter.VideoMetadata:
    return cutter.probe_video(input_path)


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
            "input_path": input_path,
            "status": "queued",
            "message": "Queued",
            "progress_percent": 0.0,
            "current_segment_name": None,
            "current_slice_percent": 0.0,
            "current_slice_index": 0,
            "completed_parts": 0,
            "total_parts": total_parts,
            "results": [],
            "planned_segments": planned_segments,
            "created_files": [],
        }

    worker = threading.Thread(
        target=_run_cut_job,
        args=(job_id, flat_parts),
        daemon=True,
    )
    worker.start()
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


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/upload", methods=["POST"])
def upload():
    if "video" not in request.files:
        return jsonify({"error": "No file provided"}), 400
    f = request.files["video"]
    if not f.filename:
        return jsonify({"error": "Empty filename"}), 400
    save_path = os.path.join(UPLOAD_DIR, f.filename)
    f.save(save_path)
    try:
        metadata = _get_input_metadata(save_path)
    except Exception as exc:
        return jsonify({"saved_path": save_path, "probe_error": str(exc)})
    return jsonify({"saved_path": save_path, "metadata": _metadata_to_dict(metadata)})


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


@app.route("/cut-status/<job_id>")
def cut_status(job_id):
    with JOB_LOCK:
        job = JOBS.get(job_id)
        if not job:
            return jsonify({"error": "Job not found"}), 404
        payload = dict(job)

    return jsonify(payload)


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


@app.route("/clear-outputs", methods=["POST"])
def clear_outputs():
    deleted = 0
    skipped = []
    for f in os.listdir(OUTPUT_DIR):
        if f.endswith(".mp4"):
            path = os.path.join(OUTPUT_DIR, f)
            try:
                os.remove(path)
                deleted += 1
            except PermissionError:
                skipped.append(
                    {
                        "name": f,
                        "reason": "File is in use by another process",
                    }
                )
    return jsonify({"deleted": deleted, "skipped": skipped})


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
    app.run(debug=True, port=5000, use_reloader=False)
