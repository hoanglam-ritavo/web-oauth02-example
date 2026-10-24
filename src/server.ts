import { loadEnvironment } from "./environment.js";
import { readConfig } from "./config.js";
import { createApp } from "./app.js";

try {
  const config = readConfig(loadEnvironment());
  const server = createApp(config).listen(config.port, config.host, () => {
    console.log(`OAuth example (${config.mode}) listening at ${config.host}:${config.port}`);
  });
  server.on("error", () => {
    console.error("Unable to start OAuth example HTTP server.");
    process.exitCode = 1;
  });
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Invalid configuration.",
  );
  process.exitCode = 1;
}
