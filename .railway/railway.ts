import { defineRailway, postgres, preserve, project, service, volume } from "railway/iac";

export default defineRailway(() => {
  const Postgres = postgres("Postgres", { region: "sfo" });
  Postgres.networking = { privateNetworkEndpoint: "postgres" };
  const postgresVolume = volume("postgres-volume", { alerts: { usage: { "100": {}, "80": {}, "95": {} } }, allowOnlineResize: true, region: "sfo", sizeMB: 5000 });
  const web = service("web", {
    start: "npm start",
    healthcheck: "/api/health",
    preDeploy: "npm run db:seed",
    replicas: { "sfo": 1 },
    env: { DATABASE_URL: preserve(), GAME_START_AT: preserve(), NODE_ENV: preserve(), PORT: preserve(), PUBLIC_ORIGIN: preserve(), SEASON_ID: preserve() },
  });
  const sync = service("sync", {
    start: "npm run sync",
    replicas: { "sfo": 1 },
    deploy: { cronSchedule: "*/10 * * * *", restartPolicyType: "NEVER" },
    env: { DATABASE_URL: preserve(), NODE_ENV: preserve(), SEASON_ID: preserve() },
  });

  return project("ponnicup", {
    resources: [web, Postgres, sync, postgresVolume],
  });
});
