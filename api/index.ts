export default function handler(_: any, res: any) {
  res.status(200).json({
    name: "notion-challenge-mcp",
    endpoint: "/mcp",
    protocol: "streamable-http",
    status: "ok",
  });
}
