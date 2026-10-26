import { randomUUID } from "node:crypto";
import type { CreativeGraph } from "@openclaw/creative-contracts";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import type { NodeResult } from "./graph/types.js";
import type { ExecutionContext, ExecutionProgress } from "./runtime/execution.js";
import { prepareStudioGraph } from "./studio-graph.js";
import type { CreativeStudio } from "./studio.js";

type Outcome = {
  ok: boolean;
  output: string;
  message: string;
  artifact: { id: string };
  nodes: NodeResult[];
  duration_ms: number;
};
export type StudioJob = {
  id: string;
  graphId: string;
  graphRevision: number;
  name: string;
  input: string;
  output: string;
  status:
    | "queued"
    | "running"
    | "cancelling"
    | "cancelled"
    | "succeeded"
    | "failed"
    | "interrupted";
  createdAt: string;
  updatedAt: string;
  progress?: ExecutionProgress;
  result?: Outcome;
  error?: string;
};
type StoredJob = StudioJob & { graph: CreativeGraph };
type Task = {
  record: StoredJob;
  controller: AbortController;
  writes: Promise<void>;
  lastWrite: number;
};
const pending = (status: StudioJob["status"]) =>
  status === "queued" || status === "running" || status === "cancelling";
function summary(record: StoredJob): StudioJob {
  const { graph: _graph, ...job } = record;
  return job;
}

/** SQLite lifecycle records, one active GPU workflow, and eight pending queue slots. */
export class StudioJobs {
  private ready?: Promise<void>;
  private queue: Task[] = [];
  private active?: Task;
  private draining?: Promise<void>;
  private stopping = false;
  constructor(
    private store: PluginStateKeyedStore<StoredJob>,
    private execute: (
      graph: CreativeGraph,
      input: string,
      output: string,
      context: ExecutionContext,
    ) => Promise<Outcome>,
    private report: (error: unknown) => void = () => {},
  ) {}

  initialize() {
    this.ready ??= (async () => {
      for (const entry of await this.store.entries()) {
        if (pending(entry.value.status)) {
          await this.store.register(entry.key, {
            ...entry.value,
            status: "interrupted",
            error:
              "Gateway stopped before completion. Rerun this workflow; sources were preserved.",
            updatedAt: new Date().toISOString(),
          });
        }
      }
    })();
    return this.ready;
  }

  async start(graph: CreativeGraph, input: string, output = "") {
    await this.initialize();
    if (this.stopping) {
      throw new Error("Gateway is shutting down");
    }
    if (!input.trim()) {
      throw new Error("Workflow source path is required");
    }
    if (this.queue.length >= 8) {
      throw new Error("Workflow queue is full (eight pending jobs)");
    }
    const snapshot = prepareStudioGraph(graph).graph;
    const now = new Date().toISOString();
    const task: Task = {
      record: {
        id: randomUUID(),
        graphId: snapshot.id,
        graphRevision: snapshot.revision,
        name: snapshot.name,
        graph: snapshot,
        input,
        output,
        status: "queued",
        createdAt: now,
        updatedAt: now,
      },
      controller: new AbortController(),
      writes: Promise.resolve(),
      lastWrite: 0,
    };
    this.queue.push(task);
    try {
      await this.persist(task);
    } catch (error) {
      this.queue = this.queue.filter((entry) => entry !== task);
      throw error;
    }
    this.draining ??= this.drain().finally(() => {
      this.draining = undefined;
    });
    void this.draining.catch(this.report);
    return summary(task.record);
  }

  private persist(task: Task) {
    const snapshot = structuredClone(task.record);
    const write = () => this.store.register(snapshot.id, snapshot);
    task.writes = task.writes.then(write, write);
    return task.writes;
  }

  private async drain() {
    while (this.queue.length && !this.stopping) {
      const task = this.queue.shift()!;
      this.active = task;
      task.record.status = "running";
      task.record.updatedAt = new Date().toISOString();
      try {
        await this.persist(task);
        task.controller.signal.throwIfAborted();
        const result = await this.execute(
          task.record.graph,
          task.record.input,
          task.record.output,
          {
            signal: task.controller.signal,
            onProgress: (progress) => {
              if (task.controller.signal.aborted) {
                return;
              }
              task.record.progress = progress;
              task.record.updatedAt = new Date().toISOString();
              if (Date.now() - task.lastWrite > 500) {
                task.lastWrite = Date.now();
                void this.persist(task).catch(this.report);
              }
            },
          },
        );
        // Native image operations may finish without observing cancellation.
        // An accepted cancel must still win before publishing job success.
        task.controller.signal.throwIfAborted();
        task.record.result = {
          ok: result.ok,
          output: result.output,
          message: result.message,
          artifact: { id: result.artifact.id },
          nodes: result.nodes,
          duration_ms: result.duration_ms,
        };
        task.record.status = "succeeded";
      } catch (error) {
        task.record.status = task.controller.signal.aborted ? "cancelled" : "failed";
        task.record.error = error instanceof Error ? error.message : String(error);
      }
      task.record.updatedAt = new Date().toISOString();
      try {
        try {
          await this.persist(task);
        } catch (error) {
          // Retry only the terminal write, never the media operation. A transient
          // store failure must not strand every already-accepted queue entry.
          this.report(error);
          await this.persist(task);
        }
      } finally {
        this.active = undefined;
      }
    }
  }

  async get(id: string) {
    await this.initialize();
    const live = [this.active, ...this.queue].find((task) => task?.record.id === id);
    const record = live?.record ?? (await this.store.lookup(id));
    if (!record) {
      throw new Error("Workflow job not found");
    }
    return summary(record);
  }

  async list() {
    await this.initialize();
    return (await this.store.entries())
      .map((entry) => summary(entry.value))
      .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 30);
  }

  async cancel(id: string) {
    await this.initialize();
    const task = [this.active, ...this.queue].find((entry) => entry?.record.id === id);
    if (!task) {
      return this.get(id);
    }
    task.controller.abort(new Error("Workflow cancelled by operator"));
    task.record.status = task === this.active ? "cancelling" : "cancelled";
    task.record.updatedAt = new Date().toISOString();
    this.queue = this.queue.filter((entry) => entry !== task);
    await this.persist(task);
    return summary(task.record);
  }

  async shutdown() {
    this.stopping = true;
    for (const task of [this.active, ...this.queue]) {
      if (task) {
        await this.cancel(task.record.id);
      }
    }
    await this.draining;
  }
}

export function registerStudioJobs(api: OpenClawPluginApi, studio: CreativeStudio) {
  const jobs = new StudioJobs(
    api.runtime.state.openKeyedStore<StoredJob>({ namespace: "studio-jobs", maxEntries: 1000 }),
    (graph, input, output, context) => studio.runGraph(graph, input, output, context),
    (error) => api.logger.error(`Studio job persistence: ${String(error)}`),
  );
  const register = (name: string, handler: (params: Record<string, unknown>) => Promise<unknown>) =>
    api.registerGatewayMethod(name, async ({ params, respond }) => {
      try {
        respond(true, await handler(params));
      } catch (error) {
        respond(true, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    });
  register("creative.studio.job.start", async (params) => {
    const graph = await studio.getGraph(typeof params.id === "string" ? params.id : "");
    if (params.revision !== graph.revision) {
      throw new Error("Workflow changed elsewhere; reload before running");
    }
    return {
      job: await jobs.start(
        graph,
        typeof params.input === "string" ? params.input : "",
        typeof params.output === "string" ? params.output : "",
      ),
    };
  });
  register("creative.studio.job.get", async (params) => ({
    job: await jobs.get(typeof params.id === "string" ? params.id : ""),
  }));
  register("creative.studio.job.cancel", async (params) => ({
    job: await jobs.cancel(typeof params.id === "string" ? params.id : ""),
  }));
  register("creative.studio.job.list", async () => ({ jobs: await jobs.list() }));
  api.registerService({
    id: "creative-studio-jobs",
    start: async () => {
      await jobs.initialize();
    },
    stop: () => jobs.shutdown(),
  });
  return jobs;
}
