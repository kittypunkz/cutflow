# CutFlow

CutFlow is a small Flask web app with local video utilities powered by FFmpeg. It starts with a tool homepage and currently supports cutting one long video into evenly timed slices or compressing one video into a smaller MP4.

## Benefits

- Fast workflow: upload one video, enter the number of output files, and generate slices automatically.
- Cleaner output planning: the app divides the full duration evenly and creates a ready-to-cut list.
- Rename before export: adjust slice names without changing the generated timing.
- Smaller files: compress uploaded videos with a simple quality-to-size control.
- Local-first controls: see FFmpeg readiness, disk space, the output folder path, and recent completed jobs.
- Faster local cleanup: clear uploaded source files separately from exported outputs.
- Live progress: watch the current slice progress and overall job progress while FFmpeg runs.
- Simple delivery: download each exported slice or compressed file directly from the browser.

## How It Works

1. Open the homepage and choose `Cut Video` or `Compress Video` from the tool cards.
2. Upload one local video file.
3. Review the detected file name, duration, and file size.
4. For cutting, split by output count or by fixed duration, generate slices, rename if needed, then click `Cut Video`.
5. For compression, choose a preset such as `Balanced` or `Small File`, then click `Compress Video`.
6. Download the generated files from the output list.

Tool routes:

- `/`: tool directory
- `/cut-video`: cut workflow
- `/compress-video`: compression workflow

Each tool page also shows the current source file, output folder path, local disk space, recent jobs, and buttons for opening the output folder or clearing uploaded source videos.

## Requirements

- Python 3.10+
- FFmpeg and FFprobe installed and available on `PATH`
- Internet access for Tailwind/Preline CDN assets in the browser, unless those assets are later vendored locally

## UI System

The frontend uses Preline-style Tailwind components through CDN scripts because this Flask app does not currently have a Node/Tailwind build pipeline. The templates load Tailwind CDN and Preline JS, then use Preline-compatible component structure for the navbar, cards, stepper, and compression accordion.

Windows install example:

```powershell
winget install Gyan.FFmpeg
```

## Installation

For non-technical Windows users, double-click:

```text
setup_and_start.bat
```

It checks for Python, creates the local `.venv`, installs `requirements.txt`, checks FFmpeg/FFprobe, offers to install missing tools with Windows Package Manager when available, then starts CutFlow.

Manual setup:

```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

## Run Locally

Start the Flask app:

```powershell
python app.py
```

Then open:

```text
http://localhost:5000
```

On Windows you can also use:

```powershell
start.bat
```

`start.bat` now runs the same setup checks, so either batch file is safe to use.

## Project Structure

- `app.py`: Flask routes, upload handling, background jobs, and progress/status APIs
- `cutter.py`: FFmpeg and FFprobe helpers, time utilities, and cutting logic
- `templates/`: HTML templates
- `static/`: CSS, JavaScript, logo, and favicon assets
- `uploads/`: uploaded source videos
- `output/`: generated slice files

## Notes

- The app currently supports one uploaded source video at a time in the UI.
- Output deletion on Windows may skip files that are still open in another program.
- Large files are supported up to the current Flask upload limit of 4 GB.
