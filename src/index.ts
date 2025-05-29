#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import axios from "axios";

// ─────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────

const API_BASE = process.env.API_BASE || "http://localhost:7890";
const API_KEY = process.env.API_KEY;
if (!API_KEY) throw new Error("Missing required API_KEY environment variable");

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

interface Template {
  _id: string;
  name: string;
  path: string;
  fields: string[];
  type: string;
  sub_type?: string;
  require_subdomain: boolean;
  require_custom_subdomain: boolean;
  published_at?: string;
  created_at: string;
  updated_at?: string;
}

// ─────────────────────────────────────────────────────────────
// Zod Schemas for Tool Validation
// ─────────────────────────────────────────────────────────────

const DeploySchema = z.object({
  template_id: z.string(),
  creds: z.any(),
});

const DeleteSchema = z.object({
  server_id: z.string(),
});

// ─────────────────────────────────────────────────────────────
// MCP Server Setup
// ─────────────────────────────────────────────────────────────

const server = new Server(
  { name: "tarxan-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// Define tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "deploy",
      description: "Deploy a server using a template ID and credentials",
      inputSchema: {
        type: "object",
        properties: {
          template_id: { type: "string", description: "ID of the template to deploy" },
          creds: { type: "object", description: "Credential payload" },
        },
        required: ["template_id", "creds"],
      },
    },
    {
      name: "delete",
      description: "Delete a server by ID",
      inputSchema: {
        type: "object",
        properties: {
          server_id: { type: "string", description: "Server ID to delete" },
        },
        required: ["server_id"],
      },
    },
    {
      name: "list_templates",
      description: "List available deployment templates",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
  ],
}));

// Tool Execution Handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  const client = axios.create({
    baseURL: API_BASE,
    headers: { "x-api-key": API_KEY },
  });

  if (name === "deploy") {
    const body = DeploySchema.parse(args);
    await client.post("/api/servers", body);
    return {
      content: [
        { type: "text", text: `✅ Deployment triggered for template ID: ${body.template_id}` },
      ],
    };
  }

  if (name === "delete") {
    const { server_id } = DeleteSchema.parse(args);
    await client.delete(`/api/servers/${server_id}`);
    return {
      content: [
        { type: "text", text: `🗑️ Server ${server_id} deleted successfully` },
      ],
    };
  }

  if (name === "list_templates") {
    const res = await client.get<Template[]>("/api/templates");
    const items = res.data;

    const text =
      items
        .map((t) => {
          const id = t._id;
          const name = t.name || "(unnamed)";
          const type = t.type || "(no type)";
          const subType = t.sub_type ? ` / ${t.sub_type}` : "";
          const fields = t.fields.join(", ");

          return `• ${name} (${id})\n  Type: ${type}${subType}\n  Fields: ${fields}`;
        })
        .join("\n\n") || "No templates found.";

    return { content: [{ type: "text", text }] };
  }

  throw new Error(`Unknown tool: ${name}`);
});

// ─────────────────────────────────────────────────────────────
// Boot the MCP Server
// ─────────────────────────────────────────────────────────────

async function run() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[Tarxan MCP] Ready on stdio using REST API backend");
}

run();
