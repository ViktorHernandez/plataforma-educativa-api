import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";

export class Metrics {
  readonly registry = new Registry();
  readonly httpDuration: Histogram<"method" | "route" | "status_code">;
  readonly authEvents: Counter<"event" | "outcome">;
  readonly outboxProcessed: Counter<"type" | "outcome">;
  readonly outboxBacklog: Gauge;
  readonly realtimeConnections: Gauge;
  readonly rateLimited: Counter<"policy">;
  readonly shedRequests: Counter;

  constructor(service: string) {
    this.registry.setDefaultLabels({ service });
    collectDefaultMetrics({ register: this.registry });
    this.httpDuration = new Histogram({
      name: "http_request_duration_seconds",
      help: "HTTP request duration in seconds",
      labelNames: ["method", "route", "status_code"],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [this.registry],
    });
    this.authEvents = new Counter({
      name: "auth_events_total",
      help: "Authentication events",
      labelNames: ["event", "outcome"],
      registers: [this.registry],
    });
    this.outboxProcessed = new Counter({
      name: "outbox_events_processed_total",
      help: "Outbox events processed by the worker",
      labelNames: ["type", "outcome"],
      registers: [this.registry],
    });
    this.outboxBacklog = new Gauge({
      name: "outbox_backlog",
      help: "Pending outbox events",
      registers: [this.registry],
    });
    this.realtimeConnections = new Gauge({
      name: "realtime_connections",
      help: "Open realtime connections on this instance",
      registers: [this.registry],
    });
    this.rateLimited = new Counter({
      name: "rate_limited_requests_total",
      help: "Requests rejected by rate limiting",
      labelNames: ["policy"],
      registers: [this.registry],
    });
    this.shedRequests = new Counter({
      name: "http_requests_shed_total",
      help: "Requests rejected because the event loop stayed overloaded",
      registers: [this.registry],
    });
  }
}
