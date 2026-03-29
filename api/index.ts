export default function handler(_: any, res: any) {
  res.status(200).json({
    name: "polydesk-mcp",
    description: "Polymarket AI Research & Trading Control Plane",
    endpoint: "/mcp",
    protocol: "streamable-http",
    status: "ok",
  });
}
