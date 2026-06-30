import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import supertest from "supertest";
import axios from "axios";
import { dashboardHealthRoutes, type ServiceConfig } from "../src/index.js";

const mockServices: ServiceConfig[] = [
  { name: "coordinator", url: "http://localhost:3001" },
  { name: "relayer", url: "http://localhost:3002" },
  { name: "resolver", url: "http://localhost:3003" }
];

function makeApp(services: ServiceConfig[]) {
  const app = express();
  app.use(dashboardHealthRoutes(services));
  return app;
}

describe("GET /dashboard/health", () => {
  it("returns a dashboard response with all services", async () => {
    vi.spyOn(axios, "get").mockResolvedValue({ data: { status: "healthy", uptime: 100 } });
    const app = makeApp(mockServices);
    const res = await supertest(app).get("/dashboard/health");
    expect(res.status).toBe(200);
    expect(res.body.services).toHaveLength(3);
    expect(res.body.summary.total).toBe(3);
  });

  it("returns degraded when any service is degraded", async () => {
    vi.spyOn(axios, "get").mockImplementation((url: string) => {
      if (url.includes(":3002/health")) {
        return Promise.resolve({ data: { status: "degraded", uptime: 100 } });
      }
      return Promise.resolve({ data: { status: "healthy", uptime: 100 } });
    });
    const app = makeApp(mockServices);
    const res = await supertest(app).get("/dashboard/health");
    expect(res.body.status).toBe("degraded");
  });

  it("returns unhealthy when a service is down", async () => {
    vi.spyOn(axios, "get").mockImplementation((url: string) => {
      if (url.includes(":3003")) {
        return Promise.reject(new Error("ECONNREFUSED"));
      }
      return Promise.resolve({ data: { status: "healthy", uptime: 100 } });
    });
    const app = makeApp(mockServices);
    const res = await supertest(app).get("/dashboard/health");
    expect(res.status).toBe(503);
    expect(res.body.status).toBe("unhealthy");
  });

  it("includes response time for each service", async () => {
    vi.spyOn(axios, "get").mockResolvedValue({ data: { status: "healthy" } });
    const app = makeApp(mockServices);
    const res = await supertest(app).get("/dashboard/health");
    for (const svc of res.body.services) {
      expect(typeof svc.responseTimeMs).toBe("number");
    }
  });

  it("normalizes coordinator status ok to healthy", async () => {
    vi.spyOn(axios, "get").mockResolvedValue({ data: { status: "ok", uptimeSeconds: 10 } });
    const app = makeApp([{ name: "coordinator", url: "http://localhost:3001" }]);
    const res = await supertest(app).get("/dashboard/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("healthy");
    expect(res.body.services[0].status).toBe("healthy");
    expect(res.body.services[0].uptime).toBe(10);
  });

  it("marks a live service degraded when readiness fails", async () => {
    vi.spyOn(axios, "get").mockImplementation((url: string) => {
      if (url.endsWith("/readyz")) {
        return Promise.resolve({
          status: 503,
          data: { status: "degraded", checks: [{ name: "database", ok: false }] }
        });
      }
      return Promise.resolve({ status: 200, data: { status: "ok" } });
    });

    const app = makeApp([{ name: "coordinator", url: "http://localhost:3001" }]);
    const res = await supertest(app).get("/dashboard/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("degraded");
    expect(res.body.services[0].checks).toContainEqual({ name: "database", ok: false });
  });
});

describe("GET /dashboard/liveness", () => {
  it("returns ok when all services are alive", async () => {
    vi.spyOn(axios, "get").mockResolvedValue({ data: {} });
    const app = makeApp(mockServices);
    const res = await supertest(app).get("/dashboard/liveness");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  it("returns degraded when a service is unreachable", async () => {
    vi.spyOn(axios, "get").mockImplementation((url: string) => {
      if (url.includes(":3002")) {
        return Promise.resolve({ data: {} });
      }
      return Promise.reject(new Error("timeout"));
    });
    const app = makeApp(mockServices);
    const res = await supertest(app).get("/dashboard/liveness");
    expect(res.status).toBe(503);
    expect(res.body.status).toBe("degraded");
  });
});

describe("GET /dashboard/readiness", () => {
  it("returns ok when all services are ready", async () => {
    vi.spyOn(axios, "get").mockResolvedValue({ data: { status: "ok", checks: [] } });
    const app = makeApp(mockServices);
    const res = await supertest(app).get("/dashboard/readiness");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  it("returns degraded when readiness checks fail", async () => {
    vi.spyOn(axios, "get").mockImplementation((url: string) => {
      if (url.includes("readyz")) {
        return Promise.resolve({ data: { status: "degraded", checks: [{ name: "db", ok: false }] } });
      }
      return Promise.resolve({ data: {} });
    });
    const app = makeApp(mockServices);
    const res = await supertest(app).get("/dashboard/readiness");
    expect(res.status).toBe(503);
    expect(res.body.status).toBe("degraded");
  });
});
