import "dotenv/config";
import { readConfig } from "./config.js";
import { createApp } from "./app.js";

try {
  const config = readConfig(process.env);
  const server = createApp(config).listen(config.port, "127.0.0.1", () => {
    console.log("OAuth example listening at " + config.appUrl);
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
