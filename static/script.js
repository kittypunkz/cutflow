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

function ensureLiveRegion() {
  if ($("app-live-region")) return $("app-live-region");
  const region = document.createElement("div");
  region.id = "app-live-region";
  region.className = "sr-only";
  region.setAttribute("aria-live", "polite");
  region.setAttribute("aria-atomic", "true");
  document.body.appendChild(region);
  return region;
}

function announce(message) {
  const region = ensureLiveRegion();
  region.textContent = "";
  window.setTimeout(() => {
    region.textContent = message || "";
  }, 25);
}

function formatBytes(bytes) {
  if (!bytes) return "0 MB";
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(mb >= 100 ? 0 : 1)} MB`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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
  if (message) announce(message);
}

function showFieldError(id, message, focusId = null) {
  const error = $(id);
  if (error) {
    error.textContent = message;
    error.classList.add("is-visible");
  }
  const field = focusId ? $(focusId) : null;
  if (field) {
    field.setAttribute("aria-invalid", "true");
    field.focus();
  }
  announce(message);
}

function clearFieldError(id, fieldId = null) {
  const error = $(id);
  if (error) error.classList.remove("is-visible");
  const field = fieldId ? $(fieldId) : null;
  if (field) field.removeAttribute("aria-invalid");
}

function setScreen(name) {
  document.body.dataset.screen = name;
  window.scrollTo({ top: 0, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
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

function setFileInfo(video) {
  currentVideo = video;
  if ($("file-info-name")) $("file-info-name").textContent = video.file_name;
  if ($("file-info-duration")) $("file-info-duration").textContent = video.metadata.duration_display;
  if ($("file-info-size")) $("file-info-size").textContent = formatBytes(video.metadata.size_bytes);
}

async function handleUpload(file) {
  clearFieldError("file-upload-error", "file-upload");
  setStatus("Uploading video...");

  const formData = new FormData();
  formData.append("video", file);

  try {
    const res = await fetch("/upload", { method: "POST", body: formData });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || "Upload failed");

    setFileInfo({
      saved_path: data.saved_path,
      file_name: data.file_name || file.name,
      metadata: data.metadata,
    });
    generatedSlices = [];
    activeJobId = null;
    activeCompressJobId = null;
    setStatus("");
    updateCompressSummary();
    setScreen("options");
  } catch (err) {
    setStatus(`Upload failed: ${err.message}`, "err");
  }
}

function goToUpload() {
  currentVideo = null;
  generatedSlices = [];
  activeJobId = null;
  activeCompressJobId = null;
  stopPolling();
  stopCompressPolling();
  if ($("file-upload")) $("file-upload").value = "";
  setStatus("");
  setScreen("upload");
}

function retryFromFailure() {
  generatedSlices = [];
  activeJobId = null;
  activeCompressJobId = null;
  setScreen("options");
}

function buildSliceName(index) {
  return `slice_${String(index).padStart(2, "0")}`;
}

function computeSlices() {
  const totalSeconds = Math.max(1, Math.floor(currentVideo.metadata.duration_seconds));
  const mode = document.querySelector("input[name='split-mode']:checked")?.value || "count";
  let count = Number.parseInt($("slice-count").value, 10);
  clearFieldError("slice-count-error", "slice-count");
  clearFieldError("slice-minutes-error", "slice-minutes");

  if (mode === "duration") {
    const minutes = Number.parseInt($("slice-minutes").value, 10);
    if (!Number.isInteger(minutes) || minutes < 1) {
      showFieldError("slice-minutes-error", "Minutes per output file must be 1 or more.", "slice-minutes");
      return null;
    }
    count = Math.ceil(totalSeconds / (minutes * 60));
  }

  if (!Number.isInteger(count) || count < 1) {
    showFieldError("slice-count-error", "Number of output files must be 1 or more.", "slice-count");
    return null;
  }
  if (count > totalSeconds) {
    showFieldError("slice-count-error", `Number of output files cannot exceed video seconds (${totalSeconds}).`, "slice-count");
    return null;
  }

  const sliceLength = totalSeconds / count;
  const slices = [];
  for (let index = 0; index < count; index += 1) {
    const startSeconds = index === 0 ? 0 : Math.round(sliceLength * index);
    const endSeconds = index === count - 1 ? totalSeconds : Math.round(sliceLength * (index + 1));
    slices.push({
      name: buildSliceName(index + 1),
      start: secondsToTimecode(startSeconds),
      end: secondsToTimecode(endSeconds),
    });
  }
  return slices;
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

function setProgressValue(element, percent) {
  if (!element) return;
  const value = Math.max(0, Math.min(100, Number(percent) || 0));
  element.style.width = `${value}%`;
  element.setAttribute("aria-valuenow", String(Math.round(value)));
}

function setProgressState(overallLabel, currentSliceName, overallPercent, slicePercent) {
  if (!$("progress-label")) return;
  $("progress-label").textContent = overallLabel;
  $("current-slice-name").textContent = currentSliceName;
  setProgressValue($("progress-bar"), overallPercent);
  setProgressValue($("slice-progress-bar"), slicePercent);
  $("progress-percent").textContent = `${overallPercent.toFixed(1)}%`;
  $("slice-progress-percent").textContent = `${slicePercent.toFixed(1)}%`;
}

function setCompressProgressState(label, percent) {
  if (!$("compress-progress-label")) return;
  $("compress-progress-label").textContent = label;
  setProgressValue($("compress-progress-bar"), percent);
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

function renderResultList(items) {
  const list = $("result-list");
  if (!list) return;
  list.innerHTML = items.map(item => item.success
    ? `<div class="output-item"><span>${escapeHtml(item.name)}</span><a class="dl-btn" href="/download/${encodeURIComponent(item.output_file)}">Download</a></div>`
    : `<div class="output-item"><span>${escapeHtml(item.name)}</span><span>${escapeHtml((item.detail || "Failed").slice(0, 180))}</span></div>`
  ).join("");
}

function showResultSuccess(items, summary = "") {
  if ($("result-summary")) $("result-summary").textContent = summary;
  renderResultList(items);
  if ($("result-success")) $("result-success").classList.remove("hidden");
  if ($("result-failure")) $("result-failure").classList.add("hidden");
  setScreen("result");
}

function showResultFailure(message) {
  if ($("result-error-message")) $("result-error-message").textContent = message;
  if ($("result-failure")) $("result-failure").classList.remove("hidden");
  if ($("result-success")) $("result-success").classList.add("hidden");
  setScreen("result");
}

function buildCutResultItems(results) {
  return results.map(result => ({
    name: result.name,
    success: result.success,
    output_file: result.output_file,
    detail: result.stderr,
  }));
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

    if (data.status === "completed") {
      activeJobId = null;
      showResultSuccess(buildCutResultItems(data.results || []));
      return;
    }
    if (data.status === "failed") {
      activeJobId = null;
      const failedResult = (data.results || []).find(result => !result.success);
      showResultFailure((failedResult?.stderr || data.message || "Cut failed").slice(0, 240));
      return;
    }
    pollTimer = setTimeout(pollJobStatus, 800);
  } catch (err) {
    activeJobId = null;
    stopPolling();
    showResultFailure(err.message);
  }
}

async function handleCutSubmit() {
  const slices = computeSlices();
  if (!slices) return;
  generatedSlices = slices;
  const validationError = validateSliceNames();
  if (validationError) {
    announce(validationError);
    return;
  }

  setScreen("processing");
  setProgressState("Adding cut job to queue...", "Preparing slices...", 0, 0);

  try {
    const res = await fetch("/cut", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input_path: currentVideo.saved_path, segments: getCutPayload() }),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || "Cut request failed");
    activeJobId = data.job_id;
    pollJobStatus();
  } catch (err) {
    showResultFailure(err.message);
  }
}

async function handleCompressSubmit() {
  const crf = Number.parseInt($("compress-level").value, 10);
  setScreen("processing");
  setCompressProgressState("Adding compression job to queue...", 0);

  try {
    const res = await fetch("/compress", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input_path: currentVideo.saved_path, crf }),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || "Compress request failed");
    activeCompressJobId = data.job_id;
    pollCompressStatus();
  } catch (err) {
    showResultFailure(err.message);
  }
}

async function pollCompressStatus() {
  if (!activeCompressJobId) return;
  try {
    const res = await fetch(`/compress-status/${encodeURIComponent(activeCompressJobId)}`);
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || "Status request failed");
    setCompressProgressState(data.message || "Compressing...", data.progress_percent || 0);

    if (data.status === "completed") {
      activeCompressJobId = null;
      const outputFile = data.result?.output_file;
      const summary = outputFile
        ? `${outputFile} created. Original ${formatBytes(data.source_size_bytes)}, compressed ${formatBytes(data.output_size_bytes)}.`
        : "";
      showResultSuccess([{ name: outputFile || "output.mp4", success: true, output_file: outputFile }], summary);
      return;
    }
    if (data.status === "failed") {
      activeCompressJobId = null;
      showResultFailure((data.result?.stderr || data.message || "Compression failed").slice(0, 240));
      return;
    }
    compressPollTimer = setTimeout(pollCompressStatus, 800);
  } catch (err) {
    activeCompressJobId = null;
    stopCompressPolling();
    showResultFailure(err.message);
  }
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

function bindSplitMode() {
  document.querySelectorAll("input[name='split-mode']").forEach(input => {
    input.addEventListener("change", () => {
      const mode = document.querySelector("input[name='split-mode']:checked")?.value || "count";
      $("count-split-panel").style.display = mode === "count" ? "" : "none";
      $("duration-split-panel").style.display = mode === "duration" ? "" : "none";
      clearFieldError("slice-count-error", "slice-count");
      clearFieldError("slice-minutes-error", "slice-minutes");
    });
  });
}

function bindPresets() {
  document.querySelectorAll(".preset-card").forEach(button => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".preset-card").forEach(card => {
        card.classList.remove("is-selected");
        card.setAttribute("aria-pressed", "false");
      });
      button.classList.add("is-selected");
      button.setAttribute("aria-pressed", "true");
      $("compress-level").value = button.dataset.crf;
      selectedEstimateLow = Number.parseInt(button.dataset.estimateLow, 10);
      selectedEstimateHigh = Number.parseInt(button.dataset.estimateHigh, 10);
      updateCompressSummary();
    });
  });
}

function bindFormValidation() {
  const upload = $("file-upload");
  if (upload) {
    upload.addEventListener("change", () => {
      if (upload.files.length) clearFieldError("file-upload-error", "file-upload");
    });
  }

  document.addEventListener("blur", event => {
    if (event.target.matches?.("input, select, textarea")) {
      event.target.toggleAttribute("aria-invalid", event.target.matches(":user-invalid"));
    }
  }, true);

  document.addEventListener("input", event => {
    if (event.target.matches?.("input, select, textarea") && event.target.hasAttribute("aria-invalid")) {
      event.target.toggleAttribute("aria-invalid", event.target.matches(":user-invalid"));
    }
  });
}

function initShared() {
  bindUploadDropzone();
  bindFormValidation();
}

function initCutPage() {
  bindSplitMode();
  $("cut-btn").addEventListener("click", handleCutSubmit);
  $("cut-back-btn").addEventListener("click", goToUpload);
  $("start-over-btn").addEventListener("click", goToUpload);
  $("try-again-btn").addEventListener("click", retryFromFailure);
  setProgressState("Waiting to start.", "No active slice.", 0, 0);
}

function initCompressPage() {
  bindPresets();
  $("compress-level").addEventListener("input", () => {
    selectedEstimateLow = 30;
    selectedEstimateHigh = 70;
    updateCompressSummary();
  });
  $("compress-btn").addEventListener("click", handleCompressSubmit);
  $("compress-back-btn").addEventListener("click", goToUpload);
  $("start-over-btn").addEventListener("click", goToUpload);
  $("try-again-btn").addEventListener("click", retryFromFailure);
  setCompressProgressState("Waiting to start.", 0);
  updateCompressSummary();
}

initShared();
if (document.body.dataset.page === "cut") initCutPage();
if (document.body.dataset.page === "compress") initCompressPage();
if (window.HSStaticMethods) {
  window.HSStaticMethods.autoInit();
}
