import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResult, jsonResult } from "../http.js";
import { getActiveEnvironment } from "../auth.js";
import { guardWrite } from "../guard.js";
import {
  addNote,
  knowledgeFilePath,
  knowledgeSummary,
  listNotes,
  removeNote,
} from "../knowledge-store.js";

export function registerTenantMemoryTools(server: McpServer): void {
  server.registerTool(
    "tenant_note_add",
    {
      title: "Remember a fact about this tenant",
      description:
        "Store a durable fact about the ACTIVE tenant so it is available in every future session. " +
        "Use this whenever the user explains something tenant-specific that should not be rediscovered: " +
        "device limitations (e.g. 'HPOMEN30L cannot use BitLocker, it runs Windows 11 Home'), licensing " +
        "constraints, naming conventions, pilot groups, known exceptions, agreed working practices, or " +
        "why something is intentionally noncompliant. Save it proactively when the user states such a " +
        "fact, then briefly confirm what you stored. Notes are kept locally in the user profile and " +
        "never leave the machine.",
      inputSchema: {
        topic: z
          .string()
          .describe(
            "What the fact is about: a device name, user, policy, app, or 'algemeen' for tenant-wide facts."
          ),
        note: z.string().describe("The fact itself, in the user's own words where possible."),
        tags: z
          .array(z.string())
          .optional()
          .describe("Optional keywords for searching, e.g. ['bitlocker','compliance']."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ topic, note, tags }) => {
      try {
        const env = getActiveEnvironment();
        const result = addNote({
          tenantId: env.tenantId,
          environmentName: env.name,
          topic,
          note,
          tags,
        });
        return jsonResult({
          stored: result.note,
          tenant: env.tenantId,
          environment: env.name,
          totalNotesForTenant: result.totalForTenant,
          storedIn: result.storedIn,
          storageNote:
            "Lokaal opgeslagen in je gebruikersprofiel, buiten het git-repository. Gaat nooit mee naar GitHub.",
        });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "tenant_notes",
    {
      title: "Recall what is known about this tenant",
      description:
        "Read the stored knowledge for the ACTIVE tenant (optionally filtered by a search term). " +
        "Call this BEFORE answering tenant-specific questions, before drawing conclusions about " +
        "compliance or configuration, and before proposing changes: a stored note may explain that " +
        "something is intentional or impossible. Set allTenants:true for an overview across all tenants.",
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe("Optional search term, matched against topic, note text and tags."),
        allTenants: z
          .boolean()
          .optional()
          .describe("true returns a count overview for every tenant instead of this tenant's notes."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, allTenants }) => {
      try {
        if (allTenants) {
          return jsonResult({ storedIn: knowledgeFilePath(), tenants: knowledgeSummary() });
        }
        const env = getActiveEnvironment();
        const notes = listNotes(env.tenantId, query);
        return jsonResult({
          tenant: env.tenantId,
          environment: env.name,
          query: query ?? null,
          count: notes.length,
          notes,
          hint:
            notes.length === 0
              ? "Nog geen kennis opgeslagen voor deze tenant. Gebruik tenant_note_add zodra de gebruiker iets tenant-specifieks vertelt."
              : undefined,
        });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "tenant_note_remove",
    {
      title: "Forget a fact about this tenant",
      description:
        "Remove one stored note from the active tenant by its id (see tenant_notes). " +
        "Requires confirm:true after user approval. Use when a fact is outdated or wrong.",
      inputSchema: {
        id: z.string().describe("Note id as shown by tenant_notes."),
        confirm: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ id, confirm }) => {
      try {
        const env = getActiveEnvironment();
        const existing = listNotes(env.tenantId).find((n) => n.id === id);
        if (!existing) {
          return errorResult(`No note with id "${id}" for tenant ${env.tenantId}.`);
        }
        const guard = guardWrite(
          confirm,
          `forget note "${existing.topic}: ${existing.note.slice(0, 200)}" for tenant ${env.tenantId}`
        );
        if (guard) return guard;
        const removed = removeNote(env.tenantId, id);
        return jsonResult({ removed, tenant: env.tenantId, remaining: listNotes(env.tenantId).length });
      } catch (err) {
        return errorResult(err);
      }
    }
  );
}
