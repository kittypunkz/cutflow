# Repository Guidelines

## Project Structure & Module Organization
`app.py` is the Flask entrypoint and defines the HTTP routes for upload, cutting, listing outputs, and downloads. `cutter.py` contains FFmpeg validation, timestamp validation, and clip generation logic. UI assets live in `templates/index.html` and `static/` (`script.js`, `style.css`). Runtime files are written to `uploads/` and `output/`; treat both as generated data, not source.

## Build, Test, and Development Commands
Create an environment and install dependencies:

```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

Run the app with `python app.py` for the normal Flask dev server on `http://localhost:5000`. On Windows, `start.bat` starts the server and opens the browser. FFmpeg must be available on `PATH`; the app also checks the WinGet install location for `Gyan.FFmpeg`.

## Coding Style & Naming Conventions
Use 4-space indentation in Python and keep functions small and single-purpose, matching `app.py` and `cutter.py`. Prefer `snake_case` for Python functions, variables, and filenames. In frontend code, keep `camelCase` for JavaScript functions and use descriptive CSS class names such as `.segment-row` and `.output-item`. Preserve the current style of short route handlers and explicit validation checks.

## Testing Guidelines
There is no automated test suite in the repository yet. For backend changes, add `pytest` tests under a future `tests/` directory and name files `test_*.py`. At minimum, manually verify `/upload`, `/cut`, `/outputs`, `/clear-outputs`, and `/download/<filename>` with a sample MP4 and invalid timestamps such as `99:99`.

## Commit & Pull Request Guidelines
Git history is not available in this workspace, so no local commit convention can be inferred. Use short, imperative commit messages such as `Add filename validation for downloads`. Pull requests should summarize behavior changes, list manual test steps, mention FFmpeg-related setup if relevant, and include UI screenshots when `templates/` or `static/` change.

## Security & Configuration Tips
Do not trust user-supplied paths beyond the existing validation. Keep large media files out of version control, and avoid committing anything from `uploads/`, `output/`, or `__pycache__/`.
