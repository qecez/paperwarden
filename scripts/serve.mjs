import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
const port = Number(process.env.PORT ?? 4175);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("Invalid PORT");
createServer(async (request, response) => {
  if (request.url !== "/" && request.url !== "/paperwarden.html") {
    response.writeHead(404).end();
    return;
  }
  try {
    const html = await readFile("dist/paperwarden.html");
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": html.length,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    });
    response.end(html);
  } catch {
    response.writeHead(503).end("Build the standalone reader first.");
  }
}).listen(port, "127.0.0.1", () =>
  console.log(`Paperwarden: http://127.0.0.1:${port}`),
);
