const TIME_RE = /^\d{2}:\d{2}:\d{2}$/;

let currentVideo = null;
let generatedSlices = [];
let activeJobId = null;
let activeCompressJobId = null;
let pollTimer = null;
let compressPollTimer = null;
let queuePollTimer = null;
let seenTerminalJobs = new Set();
let queueUserToggled = false;
let selectedEstimateLow = 35;
let selectedEstimateHigh = 65;

const STEP_ALIASES = {
  configure: "option",
  run: "process",
  download: "finish",
};

const STEP_ORDER = ["upload", "option", "process", "finish"];

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

function normalizeStep(stepName) {
  return STEP_ALIASES[stepName] || stepName || "upload";
}

function updateStep(stepName) {
  const activeStep = normalizeStep(stepName);
  const activeIndex = STEP_ORDER.indexOf(activeStep);
  document.querySelectorAll(".step").forEach(step => {
    const stepKey = normalizeStep(step.dataset.step);
    const stepIndex = STEP_ORDER.indexOf(stepKey);
    step.classList.toggle("is-active", stepKey === activeStep);
    step.classList.toggle("is-done", activeIndex > -1 && stepIndex > -1 && stepIndex < activeIndex);
    if (stepKey === activeStep) {
      step.setAttribute("aria-current", "step");
    } else {
      step.removeAttribute("aria-current");
    }
  });
}

function goToJourneyStep(stepName, shouldUpdateHash = true) {
  const activeStep = normalizeStep(stepName);
  document.querySelectorAll(".journey-panel").forEach(panel => {
    const isActive = normalizeStep(panel.dataset.journeyStep) === activeStep;
    panel.classList.toggle("is-active", isActive);
    panel.toggleAttribute("hidden", !isActive);
  });
  updateStep(activeStep);
  if (shouldUpdateHash && window.location.hash !== `#${activeStep}`) {
    history.replaceState(null, "", `#${activeStep}`);
  }
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

function setVideoMeta(video, options = {}) {
  currentVideo = video;
  const box = $("video-meta");
  if (!box) return;

  if (!video) {
    box.style.display = "none";
    box.classList.add("hidden");
    if ($("current-file-bar")) {
      $("current-file-bar").style.display = "none";
      $("current-file-bar").classList.add("hidden");
    }
    if ($("change-file-btn")) $("change-file-btn").classList.add("hidden");
    if ($("generate-btn")) $("generate-btn").disabled = true;
    if ($("compress-btn")) $("compress-btn").disabled = true;
    resetGeneratedState();
    updateCompressSummary();
    if (!options.keepStep) goToJourneyStep("upload");
    return;
  }

  box.style.display = "";
  box.classList.remove("hidden");
  $("meta-filename").textContent = video.file_name;
  $("meta-duration").textContent = video.metadata.duration_display;
  $("meta-size").textContent = formatBytes(video.metadata.size_bytes);
  if ($("current-file-bar")) {
    $("current-file-bar").style.display = "";
    $("current-file-bar").classList.remove("hidden");
    $("current-file-name").textContent = video.file_name;
    $("current-file-duration").textContent = video.metadata.duration_display;
    $("current-file-size").textContent = formatBytes(video.metadata.size_bytes);
  }
  if ($("change-file-btn")) $("change-file-btn").classList.remove("hidden");
  if ($("generate-btn")) $("generate-btn").disabled = false;
  if ($("compress-btn")) $("compress-btn").disabled = false;
  resetGeneratedState();
  updateCompressSummary();
  goToJourneyStep("option");
}

async function handleUpload(file) {
  clearFieldError("file-upload-error", "file-upload");
  setStatus("Uploading video...");
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

function clearCurrentFormAfterQueue(nextStep = "process") {
  const upload = $("file-upload");
  if (upload) upload.value = "";
  setVideoMeta(null, { keepStep: true });
  setStatus("Added to background queue. You can upload another file now.", "ok");
  if ($("cut-results")) $("cut-results").innerHTML = "";
  if ($("compress-result")) $("compress-result").textContent = "No compressed file yet.";
  goToJourneyStep(nextStep);
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
      <label>
        <span>Slice name</span>
        <input type="text" class="slice-name-input" name="slice_name_${index}" data-index="${index}" value="${escapeHtml(slice.name)}" required>
      </label>
      <label>
        <span>Start</span>
        <input type="text" name="slice_start_${index}" value="${escapeHtml(slice.start)}" readonly>
      </label>
      <label>
        <span>End</span>
        <input type="text" name="slice_end_${index}" value="${escapeHtml(slice.end)}" readonly>
      </label>
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
    showFieldError("file-upload-error", "Upload a video first.", "file-upload");
    goToJourneyStep("upload");
    return;
  }

  const totalSeconds = Math.max(1, Math.floor(currentVideo.metadata.duration_seconds));
  const mode = document.querySelector("input[name='split-mode']:checked")?.value || "count";
  let count = Number.parseInt($("slice-count").value, 10);
  clearFieldError("slice-count-error", "slice-count");
  clearFieldError("slice-minutes-error", "slice-minutes");

  if (mode === "duration") {
    const minutes = Number.parseInt($("slice-minutes").value, 10);
    if (!Number.isInteger(minutes) || minutes < 1) {
      showFieldError("slice-minutes-error", "Minutes per output file must be 1 or more.", "slice-minutes");
      return;
    }
    count = Math.ceil(totalSeconds / (minutes * 60));
  }

  if (!Number.isInteger(count) || count < 1) {
    showFieldError("slice-count-error", "Number of output files must be 1 or more.", "slice-count");
    return;
  }
  if (count > totalSeconds) {
    showFieldError("slice-count-error", `Number of output files cannot exceed video seconds (${totalSeconds}).`, "slice-count");
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
  updateStep("option");
  announce(`${generatedSlices.length} slices generated.`);
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
  if (element.tagName === "PROGRESS") {
    element.value = value;
    element.textContent = `${value.toFixed(1)}%`;
  } else {
    element.style.width = `${value}%`;
    element.setAttribute("aria-valuenow", String(Math.round(value)));
  }
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
      goToJourneyStep("finish");
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
    showFieldError("file-upload-error", "Upload a video first.", "file-upload");
    goToJourneyStep("upload");
    return;
  }
  if (!generatedSlices.length) {
    showFieldError("slice-count-error", "Generate slices first.", "slice-count");
    goToJourneyStep("option");
    return;
  }
  const validationError = validateSliceNames();
  if (validationError) {
    announce(validationError);
    return;
  }

  const button = $("cut-btn");
  button.disabled = true;
  button.textContent = "Adding...";
  $("cut-results").innerHTML = "";
  setProgressState("Adding cut job to queue...", "Preparing slices...", 0, 0);
  goToJourneyStep("process");

  try {
    const res = await fetch("/cut", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input_path: currentVideo.saved_path, segments: getCutPayload() }),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || "Cut request failed");
    activeJobId = data.job_id;
    button.disabled = false;
    button.textContent = "Cut video";
    setProgressState("Queued in background.", "Watch the export drawer.", 0, 0);
    clearCurrentFormAfterQueue();
    await refreshJobs();
  } catch (err) {
    button.disabled = false;
    button.textContent = "Cut video";
    setProgressState(`Request failed: ${err.message}`, "No active slice.", 0, 0);
  }
}

async function handleCompress() {
  if (!currentVideo) {
    showFieldError("file-upload-error", "Upload a video first.", "file-upload");
    goToJourneyStep("upload");
    return;
  }

  const crf = Number.parseInt($("compress-level").value, 10);
  const button = $("compress-btn");
  button.disabled = true;
  button.textContent = "Adding...";
  $("compress-result").textContent = "Preparing compression...";
  setCompressProgressState("Adding compression job to queue...", 0);
  goToJourneyStep("process");

  try {
    const res = await fetch("/compress", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input_path: currentVideo.saved_path, crf }),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || "Compress request failed");
    activeCompressJobId = data.job_id;
    button.disabled = false;
    button.textContent = "Compress video";
    setCompressProgressState("Queued in background.", 0);
    clearCurrentFormAfterQueue();
    await refreshJobs();
  } catch (err) {
    button.disabled = false;
    button.textContent = "Compress video";
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
      goToJourneyStep("finish");
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

function ensureQueueDrawer() {
  if ($("queue-drawer")) return;
  const drawer = document.createElement("section");
  drawer.id = "queue-drawer";
  drawer.className = "queue-drawer";
  drawer.innerHTML = `
    <button id="queue-toggle" class="queue-header" type="button" aria-expanded="true" aria-controls="queue-body">
      <span>
        <strong>Background exports</strong>
        <small id="queue-summary">No active jobs</small>
      </span>
      <span id="queue-chevron">v</span>
    </button>
    <div id="queue-body" class="queue-body">
      <div id="queue-list" class="queue-list" role="status" aria-live="polite"></div>
    </div>
  `;
  drawer.setAttribute("aria-label", "Background exports");
  document.body.appendChild(drawer);
  $("queue-toggle").addEventListener("click", () => {
    queueUserToggled = true;
    drawer.classList.toggle("is-collapsed");
    const expanded = !drawer.classList.contains("is-collapsed");
    $("queue-toggle").setAttribute("aria-expanded", String(expanded));
    $("queue-chevron").textContent = expanded ? "v" : "^";
  });
}

function jobStatusLabel(job) {
  if (job.status === "running") return "Running";
  if (job.status === "queued") return `Queued #${job.queue_position || 1}`;
  if (job.status === "completed") return "Completed";
  if (job.status === "failed") return "Failed";
  return job.status || "Waiting";
}

function renderQueueJobs(jobs) {
  ensureQueueDrawer();
  const drawer = $("queue-drawer");
  const list = $("queue-list");
  const summary = $("queue-summary");
  const visibleJobs = jobs.filter(job => ["running", "queued", "completed", "failed"].includes(job.status));
  const activeCount = visibleJobs.filter(job => job.status === "running" || job.status === "queued").length;

  drawer.classList.toggle("has-jobs", visibleJobs.length > 0);
  if (activeCount > 0) {
    queueUserToggled = false;
    drawer.classList.remove("is-collapsed");
  } else if (!queueUserToggled) {
    drawer.classList.add("is-collapsed");
  }
  const expanded = !drawer.classList.contains("is-collapsed");
  if ($("queue-toggle")) $("queue-toggle").setAttribute("aria-expanded", String(expanded));
  if ($("queue-chevron")) $("queue-chevron").textContent = expanded ? "v" : "^";
  summary.textContent = activeCount
    ? `${activeCount} active or queued`
    : visibleJobs.length
      ? "All exports finished"
      : "No active jobs";

  if (!visibleJobs.length) {
    list.innerHTML = `<div class="queue-empty">No background exports yet.</div>`;
    return;
  }

  list.innerHTML = visibleJobs.map(job => {
    const percent = Math.max(0, Math.min(100, Number(job.progress_percent || 0)));
    const files = job.output_files || [];
    const downloads = files.map(name =>
      `<a href="/download/${encodeURIComponent(name)}">Download</a>`
    ).join("");
    const detail = job.status === "failed"
      ? escapeHtml((job.result?.stderr || job.message || "Export failed").slice(0, 180))
      : escapeHtml(job.message || "");
    return `
      <article class="queue-job is-${escapeHtml(job.status)}">
        <div class="queue-job-top">
          <div>
            <strong>${escapeHtml(job.tool_label || (job.type === "compress" ? "Compress Video" : "Cut Video"))}</strong>
            <span>${escapeHtml(job.source_file || "video")}</span>
          </div>
          <em>${jobStatusLabel(job)}</em>
        </div>
        <div class="queue-progress-track">
          <div class="queue-progress-bar" style="width:${percent}%"></div>
        </div>
        <div class="queue-job-meta">
          <span>${percent.toFixed(1)}%</span>
          <span>${detail}</span>
        </div>
        ${files.length ? `<div class="queue-downloads">${downloads}</div>` : ""}
      </article>
    `;
  }).join("");
}

async function refreshJobs() {
  if (queuePollTimer) {
    clearTimeout(queuePollTimer);
    queuePollTimer = null;
  }
  try {
    const res = await fetch("/jobs");
    const jobs = await res.json();
    if (!res.ok || jobs.error) throw new Error(jobs.error || "Job list failed");
    renderQueueJobs(jobs);

    let terminalChanged = false;
    for (const job of jobs) {
      if ((job.status === "completed" || job.status === "failed") && !seenTerminalJobs.has(job.job_id)) {
        seenTerminalJobs.add(job.job_id);
        terminalChanged = true;
      }
    }
    if (terminalChanged) {
      await refreshOutputList();
      await refreshHistory();
      if (normalizeStep(window.location.hash.slice(1)) === "process") {
        goToJourneyStep("finish");
      }
    }

    const hasActive = jobs.some(job => job.status === "running" || job.status === "queued");
    queuePollTimer = setTimeout(refreshJobs, hasActive ? 1000 : 5000);
  } catch (_) {
    queuePollTimer = setTimeout(refreshJobs, 5000);
  }
}

function bindJourneyNavigation() {
  document.querySelectorAll(".step").forEach(step => {
    step.addEventListener("click", () => {
      const target = normalizeStep(step.dataset.step);
      if (target === "option" && !currentVideo) {
        showFieldError("file-upload-error", "Upload a video first.", "file-upload");
        goToJourneyStep("upload");
        return;
      }
      if (target === "process" && !currentVideo && !activeJobId && !activeCompressJobId) {
        goToJourneyStep("process");
        return;
      }
      goToJourneyStep(target);
    });
  });

  document.querySelectorAll("[data-go-step]").forEach(button => {
    button.addEventListener("click", () => {
      const target = normalizeStep(button.dataset.goStep);
      if (target === "option" && !currentVideo) {
        showFieldError("file-upload-error", "Upload a video first.", "file-upload");
        goToJourneyStep("upload");
        return;
      }
      goToJourneyStep(target);
    });
  });

  window.addEventListener("hashchange", () => {
    const hashStep = normalizeStep(window.location.hash.slice(1));
    goToJourneyStep(STEP_ORDER.includes(hashStep) ? hashStep : "upload", false);
  });

  const initialStep = normalizeStep(window.location.hash.slice(1));
  goToJourneyStep(STEP_ORDER.includes(initialStep) ? initialStep : "upload", false);
}

async function refreshOutputList() {
  const section = $("output-section");
  const list = $("output-list");
  if (!section || !list) return;
  try {
    const res = await fetch("/outputs");
    const files = await res.json();
    if (!files.length) {
      section.style.display = "";
      list.className = "output-list empty-state";
      list.textContent = "No output files yet.";
      return;
    }
    section.style.display = "";
    list.className = "output-list";
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

function confirmDialog(message, okLabel = "Delete") {
  const dialog = $("confirm-dialog");
  if (!dialog || typeof dialog.showModal !== "function") {
    return Promise.resolve(window.confirm(message));
  }
  $("confirm-dialog-message").textContent = message;
  $("confirm-ok-btn").textContent = okLabel;
  dialog.returnValue = "";
  dialog.showModal();
  return new Promise(resolve => {
    const onClose = () => {
      dialog.removeEventListener("close", onClose);
      resolve(dialog.returnValue === "confirm");
    };
    dialog.addEventListener("close", onClose);
  });
}

async function handleClearOutputs() {
  const confirmed = await confirmDialog("Delete all output files? This cannot be undone.", "Delete outputs");
  if (!confirmed) return;
  try {
    const res = await fetch("/clear-outputs", { method: "POST" });
    const data = await res.json();
    await refreshOutputList();
    if (data.skipped && data.skipped.length) {
      announce(`Deleted ${data.deleted} file(s). ${data.skipped.length} file(s) were skipped because they are still in use.`);
    }
  } catch (err) {
    announce(`Failed to delete: ${err.message}`);
  }
}

async function clearUploads() {
  const confirmed = await confirmDialog("Delete uploaded source files? Output files will stay.", "Delete uploads");
  if (!confirmed) return;
  try {
    const res = await fetch("/clear-uploads", { method: "POST" });
    const data = await res.json();
    setStatus(`Deleted ${data.deleted} uploaded file(s).`, "ok");
  } catch (err) {
    setStatus(`Failed to clear uploads: ${err.message}`, "err");
  }
}

async function openOutputFolder() {
  try {
    const res = await fetch("/open-output-folder", { method: "POST" });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || "Could not open output folder");
  } catch (err) {
    announce(`Failed to open folder: ${err.message}`);
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

  const uploadForm = $("upload-form");
  if (uploadForm) {
    uploadForm.addEventListener("submit", event => {
      event.preventDefault();
      const file = upload?.files?.[0];
      if (!file) {
        showFieldError("file-upload-error", "Choose a video file before uploading.", "file-upload");
        return;
      }
      handleUpload(file);
    });
  }

  const cutForm = $("cut-options-form");
  if (cutForm) {
    cutForm.addEventListener("submit", event => {
      event.preventDefault();
      generateSlices();
    });
  }

  const compressForm = $("compress-options-form");
  if (compressForm) {
    compressForm.addEventListener("submit", event => {
      event.preventDefault();
      handleCompress();
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
  ensureQueueDrawer();
  bindJourneyNavigation();
  bindUploadDropzone();
  bindLocalControls();
  bindFormValidation();
  if ($("clear-btn")) $("clear-btn").addEventListener("click", handleClearOutputs);
  refreshSystemStatus();
  refreshOutputList();
  refreshHistory();
  refreshJobs();
}

function initCutPage() {
  bindSplitMode();
  $("cut-btn").addEventListener("click", handleCut);
  setProgressState("Waiting to start.", "No active slice.", 0, 0);
  renderSliceList();
}

function initCompressPage() {
  bindPresets();
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
