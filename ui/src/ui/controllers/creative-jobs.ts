import type { CreativeGraph } from "@openclaw/creative-contracts";
import type { CreativeStudioController, CreativeStudioHost } from "./creative-studio.ts";

export type CreativeJob = {
  id: string;
  graphId: string;
  name: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  error?: string;
  progress?: {
    stage: string;
    frames?: number;
    totalFrames?: number;
    nodeId?: string;
    nodeIndex?: number;
    totalNodes?: number;
  };
  result?: Record<string, unknown>;
};
const pending = (job: CreativeJob) => ["queued", "running", "cancelling"].includes(job.status);

export class CreativeJobsController {
  active?: CreativeJob;
  history: CreativeJob[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  constructor(
    private host: CreativeStudioHost,
    private studio: CreativeStudioController,
  ) {}

  async load() {
    if (!this.host.client || !this.host.connected) {
      return;
    }
    try {
      const result = await this.host.client.request<{ jobs?: CreativeJob[] }>(
        "creative.studio.job.list",
        {},
      );
      this.history = result.jobs ?? [];
      const live =
        this.history.find((job) => job.status === "running" || job.status === "cancelling") ??
        this.history.find(pending);
      if (live) {
        await this.accept(live);
      } else if (this.active && pending(this.active)) {
        const finished = this.history.find((job) => job.id === this.active?.id);
        if (finished) {
          await this.accept(finished);
        }
      }
    } catch {
      /* Gateway connection state owns reconnection; jobs remain durable server-side. */
    }
    this.host.requestUpdate();
  }

  async start(graph: CreativeGraph) {
    if (!this.host.client || !this.host.connected || this.studio.running) {
      return;
    }
    this.studio.running = true;
    this.studio.lastResult = undefined;
    this.studio.lastNodes = [];
    this.host.requestUpdate();
    try {
      const result = await this.host.client.request<{ job?: CreativeJob; error?: string }>(
        "creative.studio.job.start",
        {
          id: graph.id,
          revision: graph.revision,
          input: this.studio.runForm.input,
          output: this.studio.runForm.output,
        },
      );
      if (!result.job || result.error) {
        throw new Error(result.error || "Workflow job could not start");
      }
      await this.accept(result.job);
    } catch (error) {
      this.studio.running = false;
      this.studio.lastResult = { ok: false, message: String(error) };
      this.host.requestUpdate();
    }
  }

  private async accept(job: CreativeJob) {
    this.active = job;
    this.history = [job, ...this.history.filter((entry) => entry.id !== job.id)].slice(0, 30);
    this.studio.running = pending(job);
    if (pending(job)) {
      this.schedule();
    } else {
      this.stopPolling();
      if (job.status === "succeeded" && job.result) {
        await this.studio.acceptRunResult(job.result);
      } else {
        this.studio.lastResult = { ok: false, message: job.error || `Workflow ${job.status}` };
      }
    }
    this.host.requestUpdate();
  }

  private schedule() {
    this.stopPolling();
    if (this.host.connected) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.poll();
      }, 700);
    }
  }

  async poll() {
    if (!this.host.client || !this.host.connected || !this.active) {
      return;
    }
    try {
      const result = await this.host.client.request<{ job?: CreativeJob; error?: string }>(
        "creative.studio.job.get",
        { id: this.active.id },
      );
      if (!result.job || result.error) {
        this.studio.running = false;
        this.studio.lastResult = { ok: false, message: result.error || "Workflow job unavailable" };
        this.stopPolling();
        this.host.requestUpdate();
        return;
      }
      await this.accept(result.job);
    } catch (error) {
      this.studio.lastResult = {
        ok: false,
        message: `Job continues on the gateway; reconnecting to its status. ${String(error)}`,
      };
      this.schedule();
      this.host.requestUpdate();
    }
  }

  async cancel() {
    if (!this.active || !this.host.client || !this.host.connected) {
      return;
    }
    try {
      const result = await this.host.client.request<{ job?: CreativeJob; error?: string }>(
        "creative.studio.job.cancel",
        { id: this.active.id },
      );
      if (!result.job || result.error) {
        throw new Error(result.error || "Cancellation failed");
      }
      await this.accept(result.job);
    } catch (error) {
      this.studio.lastResult = { ok: false, message: String(error) };
      this.host.requestUpdate();
    }
  }

  stopPolling() {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = undefined;
  }
}
