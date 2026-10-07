import { existsSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

/**
 * Browser tests against the real stack: Postgres, the API and a production
 * build of this app, all started here.
 *
 * The API seeds its database on every run, and seeding wipes every data table
 * first. So the database is never a default: it must be named in
 * E2E_DATABASE_URL and its name must end in `_e2e`, which no real install's
 * database does. The ports are not the usual 8000/3000 either, and an existing
 * server is never reused, because reusing a running dev server would point
 * these tests' writes at whatever database that server holds.
 */
const database = process.env.E2E_DATABASE_URL ?? "";
const databaseName = database.split("?")[0].split("/").pop() ?? "";
if (!databaseName.endsWith("_e2e")) {
  throw new Error(
    "Set E2E_DATABASE_URL to a disposable database whose name ends in _e2e. " +
      "The run seeds it, and seeding deletes everything in it.",
  );
}

const API_PORT = 8100;
const WEB_PORT = 3100;
const python =
  process.env.E2E_PYTHON ?? (existsSync("../backend/.venv/bin/python") ? ".venv/bin/python" : "python");

export default defineConfig({
  testDir: "e2e",
  // Two tests write to the shared database, and the screen sweeps read it.
  // One worker keeps every run in the same order against the same data.
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 120_000,
  // In CI, `github` turns each failure, and a server that would not start,
  // into an annotation on the run, readable without opening the log.
  reporter: process.env.CI ? [["github"], ["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    ...devices["Desktop Chrome"],
    viewport: { width: 1440, height: 900 },
    // The seed and the app's "today" are both in the reporting timezone. A
    // browser elsewhere would default the form's date to another day.
    timezoneId: "Europe/London",
    locale: "en-GB",
    trace: "retain-on-failure",
    launchOptions: process.env.E2E_CHROMIUM ? { executablePath: process.env.E2E_CHROMIUM } : {},
  },
  webServer: [
    {
      command:
        `${python} -m alembic upgrade head && ${python} scripts/seed_demo.py && ` +
        `${python} -m uvicorn app.main:app --port ${API_PORT}`,
      cwd: "../backend",
      url: `http://localhost:${API_PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      // Environment variables outrank backend/.env, so a local run cannot pick
      // up a password, a model provider or a bank feed from it.
      env: {
        DATABASE_URL: database,
        AUTH_PASSWORD_HASH: "",
        SESSION_SECRET: "",
        BACKUP_ENABLED: "false",
        LLM_PROVIDER: "none",
        BANK_SYNC_PROVIDER: "none",
      },
    },
    {
      command: `npm run build && npx next start --port ${WEB_PORT}`,
      url: `http://localhost:${WEB_PORT}`,
      reuseExistingServer: false,
      timeout: 300_000,
      env: { API_INTERNAL_URL: `http://localhost:${API_PORT}/api` },
    },
  ],
});
