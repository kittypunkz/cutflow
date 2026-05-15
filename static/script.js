const TIME_RE = /^\d{2}:\d{2}:\d{2}$/;

let currentVideo = null;
let generatedSlices = [];
let activeJobId = null;
let activeCompressJobId = null;
let pollTimer = null;
let compressPollTimer = null;
let selectedEstimateLow = 35;
let selectedEstimateHigh = 65;

function $(id) {
  return document.getElementById(id);
}

function formatBytes(bytes) {
  if (!bytes) return "0 MB";
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(mb >= 100 ? 0 : 1)} MB`;
}

function secondsToTimecode(totalSeconds) {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const hours = String(Math.floor(safe / 3600)).padStart(2, "0");
  const minutes = String(Math.floor((safe % 3600) / 60)).padStart(2, "0");
  const seconds = String(safe % 60).padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}

function setStatus(message, tone = "") {
  if (!$("upload-status")) return;
  $("upload-status").textContent = message || "";
  $("upload-status").className = `status-banner ${tone}`.trim();
}

function updateStep(stepName) {
  document.querySelectorAll(".step").forEach(step => {
    step.classList.toggle("is-active", step.dataset.step === stepName);
  });
}

function stopPolling() {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

function stopCompressPolling() {
  if (compressPollTimer) {
    clearTimeout(compressPollTimer);
    compressPollTimer = null;
  }
}

function resetGeneratedState() {
  generatedSlices = [];
  renderSliceList();
  if ($("cut-btn")) $("cut-btn").disabled = true;
  if ($("plan-summary")) {
    $("plan-summary").textContent = currentVideo
      ? "Choose split mode, then click Generate Slices."
      : "Upload a video first, then generate slices.";
  }
}

function setVideoMeta(video) {
  currentVideo = video;
  const box = $("video-meta");
  if (!box) return;

  if (!video) {
    box.style.display = "none";
    if ($("current-file-bar")) $("current-file-bar").style.display = "none";
    if ($("change-file-btn")) $("change-file-btn").classList.add("hidden");
    if ($("generate-btn")) $("generate-btn").disabled = true;
    if ($("compress-btn")) $("compress-btn").disabled = true;
    resetGeneratedState();
    updateCompressSummary();
    updateStep("upload");
    return;
  }

  box.style.display = "";
  $("meta-filename").textContent = video.file_name;
  $("meta-duration").textContent = video.metadata.duration_display;
  $("meta-size").textContent = formatBytes(video.metadata.size_bytes);
  if ($("current-file-bar")) {
    $("current-file-bar").style.display = "";
    $("current-file-name").textContent = video.file_name;
    $("current-file-duration").textContent = video.metadata.duration_display;
    $("current-file-size").textContent = formatBytes(video.metadata.size_bytes);
  }
  if ($("change-file-btn")) $("change-file-btn").classList.remove("hidden");
  if ($("generate-btn")) $("generate-btn").disabled = false;
  if ($("compress-btn")) $("compress-btn").disabled = false;
  resetGeneratedState();
  updateCompressSummary();
  updateStep("configure");
}

async function handleUpload(file) {
  setStatus("Uploading video...");
  stopPolling();
  stopCompressPolling();
  activeJobId = null;
  activeCompressJobId = null;
  if ($("cut-results")) $("cut-results").innerHTML = "";
  setProgressState("Waiting to start.", "No active slice.", 0, 0);
  setCompressProgressState("Waiting to start.", 0);
  if ($("compress-result")) $("compress-result").textContent = "No compressed file yet.";

  const formData = new FormData();
  formData.append("video", file);

  try {
    const res = await fetch("/upload", { method: "POST", body: formData });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || "Upload failed");

    setVideoMeta({
      saved_path: data.saved_path,
      file_name: data.file_name || file.name,
      metadata: data.metadata,
    });
    setStatus(`Uploaded ${file.name}`, "ok");
  } catch (err) {
    setVideoMeta(null);
    setStatus(`Upload failed: ${err.message}`, "err");
  }
}

function buildSliceName(index) {
  return `slice_${String(index).padStart(2, "0")}`;
}

function renderSliceList() {
  const container = $("segments-container");
  if (!container) return;

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
  const summary = $("plan-summary");
  if (!summary) return;
  if (!currentVideo) {
    summary.textContent = "Upload a video first, then generate slices.";
    return;
  }
  if (!generatedSlices.length) {
    summary.textContent = "Choose split mode, then click Generate Slices.";
    return;
  }
  const first = generatedSlices[0];
  const last = generatedSlices[generatedSlices.length - 1];
  summary.textContent =
    `${generatedSlices.length} slices generated from ${first.start} to ${last.end}. Rename slice names if needed.`;
}

function generateSlices() {
  if (!currentVideo) {
    alert("Upload a video first.");
    return;
  }

  const totalSeconds = Math.max(1, Math.floor(currentVideo.metadata.duration_seconds));
  const mode = document.querySelector("input[name='split-mode']:checked")?.value || "count";
  let count = Number.parseInt($("slice-count").value, 10);

  if (mode === "duration") {
    const minutes = Number.parseInt($("slice-minutes").value, 10);
    if (!Number.isInteger(minutes) || minutes < 1) {
      alert("Minutes per output file must be 1 or more.");
      return;
    }
    count = Math.ceil(totalSeconds / (minutes * 60));
  }

  if (!Number.isInteger(count) || count < 1) {
    alert("Number of output files must be 1 or more.");
    return;
  }
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
  if ($("cut-btn")) $("cut-btn").disabled = false;
  updateStep("run");
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
    if (!slice.name || !slice.name.trim()) return "Every slice needs a name before cutting.";
    if (!TIME_RE.test(slice.start) || !TIME_RE.test(slice.end)) {
      return `Invalid slice time found for ${slice.name}.`;
    }
  }
  return null;
}

function setProgressState(overallLabel, currentSliceName, overallPercent, slicePercent) {
  if (!$("progress-label")) return;
  $("progress-label").textContent = overallLabel;
  $("current-slice-name").textContent = currentSliceName;
  $("progress-bar").style.width = `${overallPercent}%`;
  $("slice-progress-bar").style.width = `${slicePercent}%`;
  $("progress-percent").textContent = `${overallPercent.toFixed(1)}%`;
  $("slice-progress-percent").textContent = `${slicePercent.toFixed(1)}%`;
}

function setCompressProgressState(label, percent) {
  if (!$("compress-progress-label")) return;
  $("compress-progress-label").textContent = label;
  $("compress-progress-bar").style.width = `${percent}%`;
  $("compress-progress-percent").textContent = `${percent.toFixed(1)}%`;
}

function updateCompressSummary() {
  if (!$("compress-level")) return;
  const crf = $("compress-level").value;
  $("compress-level-value").textContent = crf;
  if (!currentVideo) {
    $("compress-summary").textContent = `Upload a video, then choose a preset. Current advanced value is CRF ${crf}.`;
    return;
  }
  const low = Math.round(currentVideo.metadata.size_bytes * (selectedEstimateLow / 100));
  const high = Math.round(currentVideo.metadata.size_bytes * (selectedEstimateHigh / 100));
  $("compress-summary").textContent =
    `Original ${formatBytes(currentVideo.metadata.size_bytes)}. Estimated output ${formatBytes(low)}-${formatBytes(high)} using CRF ${crf}.`;
}

function renderResults(results) {
  const resultsDiv = $("cut-results");
  if (!resultsDiv) return;
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
    setProgressState(
      overallLabel,
      data.current_segment_name || "No active slice.",
      data.progress_percent || 0,
      data.current_slice_percent || 0,
    );

    if (data.status === "completed" || data.status === "failed") {
      renderResults(data.results || []);
      stopPolling();
      activeJobId = null;
      $("cut-btn").disabled = false;
      $("cut-btn").textContent = "Cut Video";
      await refreshOutputList();
      await refreshHistory();
      updateStep("download");
      return;
    }
    pollTimer = setTimeout(pollJobStatus, 800);
  } catch (err) {
    setProgressState(`Progress error: ${err.message}`, "No active slice.", 0, 0);
    stopPolling();
    activeJobId = null;
    $("cut-btn").disabled = false;
    $("cut-btn").textContent = "Cut Video";
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

  const button = $("cut-btn");
  button.disabled = true;
  button.textContent = "Starting...";
  $("cut-results").innerHTML = "";
  setProgressState("Creating cut job...", "Preparing slices...", 0, 0);
  updateStep("run");
  stopPolling();

  try {
    const res = await fetch("/cut", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input_path: currentVideo.saved_path, segments: getCutPayload() }),
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

async function handleCompress() {
  if (!currentVideo) {
    alert("Upload a video first.");
    return;
  }

  const crf = Number.parseInt($("compress-level").value, 10);
  const button = $("compress-btn");
  button.disabled = true;
  button.textContent = "Starting...";
  $("compress-result").textContent = "Preparing compression...";
  setCompressProgressState("Creating compression job...", 0);
  updateStep("run");
  stopCompressPolling();

  try {
    const res = await fetch("/compress", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input_path: currentVideo.saved_path, crf }),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || "Compress request failed");
    activeCompressJobId = data.job_id;
    button.textContent = "Compressing...";
    pollCompressStatus();
  } catch (err) {
    button.disabled = false;
    button.textContent = "Compress Video";
    setCompressProgressState(`Request failed: ${err.message}`, 0);
    $("compress-result").textContent = "Compression did not start.";
  }
}

async function pollCompressStatus() {
  if (!activeCompressJobId) return;
  try {
    const res = await fetch(`/compress-status/${encodeURIComponent(activeCompressJobId)}`);
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || "Status request failed");
    setCompressProgressState(data.message || "Compressing...", data.progress_percent || 0);

    if (data.status === "completed" || data.status === "failed") {
      stopCompressPolling();
      activeCompressJobId = null;
      $("compress-btn").disabled = false;
      $("compress-btn").textContent = "Compress Video";
      if (data.status === "completed" && data.result?.output_file) {
        $("compress-result").textContent =
          `${data.result.output_file} created. Original ${formatBytes(data.source_size_bytes)}, compressed ${formatBytes(data.output_size_bytes)}.`;
      } else {
        $("compress-result").textContent =
          (data.result?.stderr || data.message || "Compression failed").slice(0, 240);
      }
      await refreshOutputList();
      await refreshHistory();
      updateStep("download");
      return;
    }
    compressPollTimer = setTimeout(pollCompressStatus, 800);
  } catch (err) {
    setCompressProgressState(`Progress error: ${err.message}`, 0);
    stopCompressPolling();
    activeCompressJobId = null;
    $("compress-btn").disabled = false;
    $("compress-btn").textContent = "Compress Video";
  }
}

async function refreshOutputList() {
  const section = $("output-section");
  const list = $("output-list");
  if (!section || !list) return;
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

async function refreshHistory() {
  const list = $("history-list");
  if (!list) return;
  try {
    const res = await fetch("/job-history");
    const items = await res.json();
    if (!items.length) {
      list.className = "history-list empty-state";
      list.textContent = "No completed jobs yet.";
      return;
    }
    list.className = "history-list";
    list.innerHTML = items.map(item => `
      <div class="history-item">
        <div>
          <strong>${item.type === "compress" ? "Compressed" : "Cut"} ${item.source_file || "video"}</strong>
          <span>${item.completed_at} - ${item.output_count || 0} output file(s)</span>
        </div>
        <div class="history-actions">
          <span>${formatBytes(item.output_size_bytes || 0)}</span>
          ${(item.output_files || []).map(name => `<a href="/download/${encodeURIComponent(name)}">Download</a>`).join("")}
        </div>
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

async function clearUploads() {
  if (!confirm("Delete uploaded source files? Output files will stay.")) return;
  try {
    const res = await fetch("/clear-uploads", { method: "POST" });
    const data = await res.json();
    alert(`Deleted ${data.deleted} uploaded file(s).`);
  } catch (err) {
    alert(`Failed to clear uploads: ${err.message}`);
  }
}

async function openOutputFolder() {
  try {
    const res = await fetch("/open-output-folder", { method: "POST" });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || "Could not open output folder");
  } catch (err) {
    alert(`Failed to open folder: ${err.message}`);
  }
}

async function refreshSystemStatus() {
  try {
    const res = await fetch("/system-status");
    const data = await res.json();
    if ($("ffmpeg-status")) {
      $("ffmpeg-status").textContent = data.ffmpeg_ready ? "FFmpeg ready" : "FFmpeg missing";
      $("ffmpeg-status").classList.toggle("is-ok", data.ffmpeg_ready);
      $("ffmpeg-status").classList.toggle("is-bad", !data.ffmpeg_ready);
    }
    if ($("disk-status")) {
      $("disk-status").textContent = `Disk free: ${formatBytes(data.disk_free_bytes)}`;
      $("disk-status").classList.toggle("is-ok", data.output_writable);
      $("disk-status").classList.toggle("is-bad", !data.output_writable);
    }
    if ($("output-path")) {
      $("output-path").textContent = `Output: ${data.output_dir}`;
      $("output-path").title = data.output_dir;
    }
  } catch (_) {}
}

function bindUploadDropzone() {
  const upload = $("file-upload");
  const tile = document.querySelector(".upload-tile");
  if (!upload || !tile) return;
  upload.addEventListener("change", event => {
    if (event.target.files[0]) handleUpload(event.target.files[0]);
  });
  tile.addEventListener("dragover", event => {
    event.preventDefault();
    tile.classList.add("is-dragging");
  });
  tile.addEventListener("dragleave", () => tile.classList.remove("is-dragging"));
  tile.addEventListener("drop", event => {
    event.preventDefault();
    tile.classList.remove("is-dragging");
    const file = event.dataTransfer.files[0];
    if (file) handleUpload(file);
  });
}

function bindLocalControls() {
  if ($("change-file-btn")) $("change-file-btn").addEventListener("click", () => $("file-upload").click());
  if ($("clear-uploads-btn")) $("clear-uploads-btn").addEventListener("click", clearUploads);
  if ($("open-output-btn")) $("open-output-btn").addEventListener("click", openOutputFolder);
  if ($("open-output-btn-secondary")) $("open-output-btn-secondary").addEventListener("click", openOutputFolder);
}

function bindSplitMode() {
  document.querySelectorAll("input[name='split-mode']").forEach(input => {
    input.addEventListener("change", () => {
      const mode = document.querySelector("input[name='split-mode']:checked")?.value || "count";
      $("count-split-panel").style.display = mode === "count" ? "" : "none";
      $("duration-split-panel").style.display = mode === "duration" ? "" : "none";
    });
  });
}

function bindPresets() {
  document.querySelectorAll(".preset-card").forEach(button => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".preset-card").forEach(card => card.classList.remove("is-selected"));
      button.classList.add("is-selected");
      $("compress-level").value = button.dataset.crf;
      selectedEstimateLow = Number.parseInt(button.dataset.estimateLow, 10);
      selectedEstimateHigh = Number.parseInt(button.dataset.estimateHigh, 10);
      updateCompressSummary();
    });
  });
}

function initShared() {
  bindUploadDropzone();
  bindLocalControls();
  if ($("clear-btn")) $("clear-btn").addEventListener("click", handleClearOutputs);
  refreshSystemStatus();
  refreshOutputList();
  refreshHistory();
}

function initCutPage() {
  bindSplitMode();
  $("generate-btn").addEventListener("click", generateSlices);
  $("cut-btn").addEventListener("click", handleCut);
  setProgressState("Waiting to start.", "No active slice.", 0, 0);
  renderSliceList();
}

function initCompressPage() {
  bindPresets();
  $("compress-btn").addEventListener("click", handleCompress);
  $("compress-level").addEventListener("input", () => {
    selectedEstimateLow = 30;
    selectedEstimateHigh = 70;
    updateCompressSummary();
  });
  setCompressProgressState("Waiting to start.", 0);
  updateCompressSummary();
}

initShared();
if (document.body.dataset.page === "cut") initCutPage();
if (document.body.dataset.page === "compress") initCompressPage();
if (window.HSStaticMethods) {
  window.HSStaticMethods.autoInit();
}
