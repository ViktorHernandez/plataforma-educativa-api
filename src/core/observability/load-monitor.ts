import { monitorEventLoopDelay, performance, type EventLoopUtilization, type ELDHistogram } from "node:perf_hooks";

export interface LoadMonitorOptions {
  maxEventLoopDelayMs: number;
  maxEventLoopUtilization: number;
  sampleIntervalMs: number;
  sustainedSamples: number;
}

export interface LoadSample {
  eventLoopDelayMs: number;
  eventLoopUtilization: number;
  overloaded: boolean;
  consecutiveOverloadedSamples: number;
}

const histogramResolutionMs = 10;

export class EventLoopLoadMonitor {
  private histogram: ELDHistogram | null = null;
  private timer: NodeJS.Timeout | null = null;
  private baseline: EventLoopUtilization | null = null;
  private consecutive = 0;
  private last: LoadSample = { eventLoopDelayMs: 0, eventLoopUtilization: 0, overloaded: false, consecutiveOverloadedSamples: 0 };

  constructor(private readonly options: LoadMonitorOptions) {}

  get running(): boolean {
    return this.timer !== null;
  }

  get shedding(): boolean {
    return this.consecutive >= this.options.sustainedSamples;
  }

  get lastSample(): LoadSample {
    return this.last;
  }

  get retryAfterSeconds(): number {
    return Math.max(1, Math.ceil((this.options.sampleIntervalMs * this.options.sustainedSamples) / 1000));
  }

  start(): void {
    if (this.timer) return;
    this.histogram = monitorEventLoopDelay({ resolution: histogramResolutionMs });
    this.histogram.enable();
    this.baseline = performance.eventLoopUtilization();
    this.consecutive = 0;
    this.timer = setInterval(() => this.sample(), this.options.sampleIntervalMs);
    this.timer.unref();
  }

  sample(): LoadSample {
    if (!this.histogram || !this.baseline) return this.last;
    const current = performance.eventLoopUtilization();
    const utilization = performance.eventLoopUtilization(current, this.baseline).utilization;
    this.baseline = current;
    const mean = this.histogram.count > 0 ? this.histogram.mean / 1e6 : 0;
    const eventLoopDelayMs = Math.max(0, mean - histogramResolutionMs);
    this.histogram.reset();
    const overloaded = eventLoopDelayMs > this.options.maxEventLoopDelayMs || utilization > this.options.maxEventLoopUtilization;
    this.consecutive = overloaded ? this.consecutive + 1 : 0;
    this.last = { eventLoopDelayMs, eventLoopUtilization: utilization, overloaded, consecutiveOverloadedSamples: this.consecutive };
    return this.last;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.histogram?.disable();
    this.histogram = null;
    this.baseline = null;
    this.consecutive = 0;
  }
}
