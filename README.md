# CutFlow

CutFlow is a small Flask web app for splitting one long video into evenly timed slices. It is designed for recordings such as meetings, podcasts, webinars, and long-form content where you want several output files without manually calculating start and end times.

## Benefits

- Fast workflow: upload one video, enter the number of output files, and generate slices automatically.
- Cleaner output planning: the app divides the full duration evenly and creates a ready-to-cut list.
- Rename before export: adjust slice names without changing the generated timing.
- Live progress: watch the current slice progress and overall job progress while FFmpeg runs.
- Simple delivery: download each exported file directly from the browser.

## How It Works

1. Upload one local video file.
2. Review the detected file name, duration, and file size.
3. Enter the number of output files you want.
4. Click `Generate Slices`.
5. Rename any slice names if needed.
6. Click `Cut Video`.
7. Download the generated files from the output list.

## Requirements

- Python 3.10+
- FFmpeg and FFprobe installed and available on `PATH`

Windows install example:

```powershell
winget install Gyan.FFmpeg
```

## Installation

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
