import { FastMCP } from "fastmcp";
import { z } from "zod";
import axios from "axios";

const API_BASE = "https://api.resend.com";
let apiKey = process.env.RESEND_API_KEY || "";

const server = new FastMCP({
  name: "resend-mcp",
  version: "1.0.0",
  transportType: "stdio",
});

server.addTool({
  name: "send_email",
  description: "Send an email via Resend API",
  parameters: z.object({
    to: z.string().describe("Recipient email address"),
    subject: z.string().describe("Email subject"),
    html: z.string().describe("HTML body content"),
    from: z.string().describe("Sender email address (must be a verified domain in Resend)"),
  }),
  execute: async (args) => {
    try {
      console.log("[resend] Sending email to:", args.to, "subject:", args.subject);
      const res = await axios.post(
        `${API_BASE}/emails`,
        {
          from: args.from || apiKey,
          to: [args.to],
          subject: args.subject,
          html: args.html,
        },
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          timeout: 15000,
        }
      );
      console.log("[resend] Sent OK, id:", res.data.id);
      return JSON.stringify({ success: true, id: res.data.id }, null, 2);
    } catch (error) {
      const detail = error.response?.data || error.message;
      console.error("[resend] Error:", JSON.stringify(detail));
      return JSON.stringify({ error: detail }, null, 2);
    }
  },
});

server.start();
