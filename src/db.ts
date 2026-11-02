import postgres from "postgres";
import { config } from "./config";

const sql = postgres(config.databaseUrl, {
  debug: config.logLevel === "DEBUG",
  max: 10,
  idle_timeout: 30,
  connect_timeout: 10,
  connection: {
    timezone: "Asia/Jakarta",
  },
});

export { sql };
export type Sql = typeof sql;
