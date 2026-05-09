const TIME_RE = /^\d{2}:\d{2}:\d{2}$/;

let currentVideo = null;
let generatedSlices = [];
let activeJobId = null;
let pollTimer = null;

function secondsToTimecode(totalSeconds) {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const hours = String(Math.floor(safe / 3600)).padStart(2, "0");
  const minutes = String(Math.floor((safe % 3600) / 60)).padStart(2, "0");
  const seconds = String(safe % 60).padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}

function formatBytes(bytes) {
  if (!bytes) return "0 MB";
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(mb >= 100 ? 0 : 1)} MB`;
}

function setStatus(message, tone = "") {
  const status = document.getElementById("upload-status");
  status.textContent = message || "";
  status.className = `status-banner ${tone}`.trim();
}

function resetGeneratedState() {
  generatedSlices = [];
  renderSliceList();
  document.getElementById("plan-summary").textContent = currentVideo
    ? "Enter the number of output files, then click Generate Slices."
    : "Upload a video first, then generate slices.";
}

function setVideoMeta(video) {
  currentVideo = video;
  const box = document.getElementById("video-meta");

  if (!video) {
    box.style.display = "none";
    resetGeneratedState();
    return;
  }

  box.style.display = "";
  document.getElementById("meta-filename").textContent = video.file_name;
  document.getElementById("meta-duration").textContent = video.metadata.duration_display;
  document.getElementById("meta-size").textContent = formatBytes(video.metadata.size_bytes);
  resetGeneratedState();
}

function buildSliceName(index) {
  return `slice_${String(index).padStart(2, "0")}`;
}

function renderSliceList() {
  const container = document.getElementById("segments-container");

  if (!generatedSlices.length) {
    container.className = "segments-container empty-state";
    container.textContent = "No slices generated yet.";
    return;
  }

  container.className = "segments-container";
  container.innerHTML = generatedSlices.map((slice, index) => `
    <div class="segment-row">
      <input type="text" class="slice-name-input" data-index="${index}" value="${slice.name}">
      <input type="text" value="${slice.start}" readonly>
      <input type="text" value="${slice.end}" readonly>
    </div>
  `).join("");

  container.querySelectorAll(".slice-name-input").forEach(input => {
    input.addEventListener("input", event => {
      const idx = Number.parseInt(event.target.dataset.index, 10);
      generatedSlices[idx].name = event.target.value;
    });
  });
}

function updatePlanSummary() {
  const summary = document.getElementById("plan-summary");

  if (!currentVideo) {
    summary.textContent = "Upload a video first, then generate slices.";
    return;
  }

  if (!generatedSlices.length) {
    summary.textContent = "Enter the number of output files, then click Generate Slices.";
    return;
  }

  const first = generatedSlices[0];
  const last = generatedSlices[generatedSlices.length - 1];
  summary.textContent =
    `${generatedSlices.length} slices generated from ${first.start} to ${last.end}. You can rename slice names before cutting.`;
}

function generateSlices() {
  if (!currentVideo) {
    alert("Upload a video first.");
    return;
  }

  const count = Number.parseInt(document.getElementById("slice-count").value, 10);
  if (!Number.isInteger(count) || count < 1) {
    alert("Number of output files must be 1 or more.");
    return;
  }

  const totalSeconds = Math.max(1, Math.floor(currentVideo.metadata.duration_seconds));
  if (count > totalSeconds) {
    alert(`Number of output files cannot exceed video seconds (${totalSeconds}).`);
    return;
  }
  const sliceLength = totalSeconds / count;
  generatedSlices = [];

  for (let index = 0; index < count; index += 1) {
    const startSeconds = index === 0 ? 0 : Math.round(sliceLength * index);
    const endSeconds = index === count - 1 ? totalSeconds : Math.round(sliceLength * (index + 1));
    generatedSlices.push({
      name: buildSliceName(index + 1),
      start: secondsToTimecode(startSeconds),
      end: secondsToTimecode(endSeconds),
    });
  }

  renderSliceList();
  updatePlanSummary();
}

async function handleUpload(file) {
  setStatus("Uploading video...");
  stopPolling();
  activeJobId = null;
  document.getElementById("cut-results").innerHTML = "";
  setProgressState("Waiting to start.", "No active slice.", 0, 0);

  const formData = new FormData();
  formData.append("video", file);

  try {
    const res = await fetch("/upload", { method: "POST", body: formData });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || "Upload failed");

    setVideoMeta({
      saved_path: data.saved_path,
      file_name: file.name,
      metadata: data.metadata,
    });
    setStatus(`Uploaded ${file.name}`, "ok");
  } catch (err) {
    setVideoMeta(null);
    setStatus(`Upload failed: ${err.message}`, "err");
  }
}

function getCutPayload() {
  return generatedSlices.map(slice => ({
    name: (slice.name || "").trim(),
    start: slice.start,
    end: slice.end,
  }));
}

function validateSliceNames() {
  for (const slice of generatedSlices) {
    if (!slice.name || !slice.name.trim()) {
      return "Every slice needs a name before cutting.";
    }
    if (!TIME_RE.test(slice.start) || !TIME_RE.test(slice.end)) {
      return `Invalid slice time found for ${slice.name}.`;
    }
  }
  return null;
}

function setProgressState(overallLabel, currentSliceName, overallPercent, slicePercent) {
  document.getElementById("progress-label").textContent = overallLabel;
  document.getElementById("current-slice-name").textContent = currentSliceName;
  document.getElementById("progress-bar").style.width = `${overallPercent}%`;
  document.getElementById("slice-progress-bar").style.width = `${slicePercent}%`;
  document.getElementById("progress-percent").textContent = `${overallPercent.toFixed(1)}%`;
  document.getElementById("slice-progress-percent").textContent = `${slicePercent.toFixed(1)}%`;
}

function stopPolling() {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

function renderResults(results) {
  const resultsDiv = document.getElementById("cut-results");
  resultsDiv.innerHTML = "";

  for (const result of results) {
    const item = document.createElement("div");
    item.className = `result-item ${result.success ? "success" : "error"}`;
    item.innerHTML = result.success
      ? `<span class="result-name">${result.name}</span><span class="result-detail">${result.output_file}</span>`
      : `<span class="result-name">${result.name}</span><span class="result-detail">${(result.stderr || "Unknown error").slice(0, 220)}</span>`;
    resultsDiv.appendChild(item);
  }
}

async function pollJobStatus() {
  if (!activeJobId) return;

  try {
    const res = await fetch(`/cut-status/${encodeURIComponent(activeJobId)}`);
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || "Status request failed");

    const overallLabel = data.current_slice_index
      ? `Slice ${data.current_slice_index} of ${data.total_parts}: ${data.message}`
      : data.message;
    const currentSliceName = data.current_segment_name || "No active slice.";
    setProgressState(
      overallLabel,
      currentSliceName,
      data.progress_percent || 0,
      data.current_slice_percent || 0,
    );

    if (data.status === "completed" || data.status === "failed") {
      renderResults(data.results || []);
      stopPolling();
      activeJobId = null;
      const button = document.getElementById("cut-btn");
      button.disabled = false;
      button.textContent = "Cut Video";
      await refreshOutputList();
      return;
    }

    pollTimer = setTimeout(pollJobStatus, 800);
  } catch (err) {
    setProgressState(`Progress error: ${err.message}`, "No active slice.", 0, 0);
    stopPolling();
    activeJobId = null;
    const button = document.getElementById("cut-btn");
    button.disabled = false;
    button.textContent = "Cut Video";
  }
}

async function handleCut() {
  if (!currentVideo) {
    alert("Upload a video first.");
    return;
  }
  if (!generatedSlices.length) {
    alert("Generate slices first.");
    return;
  }

  const validationError = validateSliceNames();
  if (validationError) {
    alert(validationError);
    return;
  }

  const button = document.getElementById("cut-btn");
  button.disabled = true;
  button.textContent = "Starting...";
  document.getElementById("cut-results").innerHTML = "";
  setProgressState("Creating cut job...", "Preparing slices...", 0, 0);
  stopPolling();

  try {
    const res = await fetch("/cut", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input_path: currentVideo.saved_path,
        segments: getCutPayload(),
      }),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || "Cut request failed");

    activeJobId = data.job_id;
    button.textContent = "Cutting...";
    pollJobStatus();
  } catch (err) {
    button.disabled = false;
    button.textContent = "Cut Video";
    setProgressState(`Request failed: ${err.message}`, "No active slice.", 0, 0);
  }
}

async function refreshOutputList() {
  const section = document.getElementById("output-section");
  const list = document.getElementById("output-list");

  try {
    const res = await fetch("/outputs");
    const files = await res.json();

    if (!files.length) {
      section.style.display = "none";
      return;
    }

    section.style.display = "";
    list.innerHTML = files.map(file => `
      <div class="output-item">
        <span>${file.name}</span>
        <strong>${formatBytes(file.size_bytes)}</strong>
        <a class="dl-btn" href="/download/${encodeURIComponent(file.name)}">Download</a>
      </div>
    `).join("");
  } catch (_) {}
}

async function handleClearOutputs() {
  if (!confirm("Delete all output files?")) return;
  try {
    const res = await fetch("/clear-outputs", { method: "POST" });
    const data = await res.json();
    await refreshOutputList();
    if (data.skipped && data.skipped.length) {
      alert(`Deleted ${data.deleted} file(s). ${data.skipped.length} file(s) were skipped because they are still in use.`);
    }
  } catch (err) {
    alert(`Failed to delete: ${err.message}`);
  }
}

document.getElementById("file-upload").addEventListener("change", event => {
  if (event.target.files[0]) handleUpload(event.target.files[0]);
});
document.getElementById("generate-btn").addEventListener("click", generateSlices);
document.getElementById("cut-btn").addEventListener("click", handleCut);
document.getElementById("clear-btn").addEventListener("click", handleClearOutputs);

setProgressState("Waiting to start.", "No active slice.", 0, 0);
renderSliceList();
refreshOutputList();
