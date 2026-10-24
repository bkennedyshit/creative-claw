import { html, nothing } from "lit";
import type { CreativeStudioController } from "../controllers/creative-studio.ts";

export function renderCreativeJobs(studio: CreativeStudioController) {
  const job = studio.jobs.active;
  const progress = job?.progress;
  const frameFraction = progress?.totalFrames
    ? Math.min(1, (progress.frames ?? 0) / progress.totalFrames)
    : 0;
  const fraction =
    job?.status === "succeeded"
      ? 1
      : progress?.totalNodes
        ? Math.min(0.99, ((progress.nodeIndex ?? 0) + frameFraction) / progress.totalNodes)
        : 0;
  return html`${job
    ? html`<section class="creative-job" aria-label="Workflow job" role="status">
        <strong>${job.name} · ${job.status}</strong>
        ${studio.running
          ? html`<progress aria-label="Workflow progress" max="1" .value=${fraction}></progress>
              <p>
                ${progress?.stage ?? "Waiting"}${progress?.totalNodes
                  ? ` · node ${(progress.nodeIndex ?? 0) + 1}/${progress.totalNodes}`
                  : ""}${progress?.frames !== undefined
                  ? ` · frame ${progress.frames}${progress.totalFrames ? ` of ≈${progress.totalFrames}` : ""}`
                  : ""}
              </p>
              <button
                class="btn"
                ?disabled=${job.status === "cancelling"}
                @click=${() => void studio.jobs.cancel()}
              >
                ${job.status === "cancelling"
                  ? "Cancelling after the current native call…"
                  : "Cancel workflow"}
              </button>
              <p class="muted">
                The job continues on the gateway if this page reloads. Cancellation waits for the
                current native inference to return.
              </p>`
          : nothing}
        ${job.error ? html`<p class="callout warn">${job.error}</p>` : nothing}
      </section>`
    : nothing}
  ${studio.jobs.history.length
    ? html`<details>
        <summary>Recent workflow jobs · ${studio.jobs.history.length}</summary>
        ${studio.jobs.history
          .slice(0, 8)
          .map(
            (entry) =>
              html`<p>
                <strong>${entry.name}</strong> · ${entry.status} ·
                ${new Date(entry.createdAt).toLocaleString()}
              </p>`,
          )}
      </details>`
    : nothing}`;
}
