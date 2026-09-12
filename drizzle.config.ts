import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dialect: "postgresql",
  dbCredentials: {
    // drizzle-kit reads DATABASE_URL from env; .env is loaded via dotenv-cli or shell.
    // e.g. postgres://openpay:openpay@localhost:5432/openpay
    url: process.env.DATABASE_URL ?? "postgres://openpay:openpay@localhost:5432/openpay",
  },
});
