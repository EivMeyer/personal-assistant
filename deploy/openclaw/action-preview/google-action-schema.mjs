import { z } from "zod";
const id = z.string().min(1).max(1024);
const text = z.string().max(12000);
const times = {
  start: z.iso.datetime({ offset: true }),
  end: z.iso.datetime({ offset: true }),
};
const existing = {
  eventId: id,
  expectedSummary: z.string().max(500),
  expectedOrganizer: z.email(),
  expectedAttendees: z.array(z.email()).max(200),
  expectedEtag: id.regex(/^"[^"\r\n]+"$/),
};
const details = {
  summary: z.string().min(1).max(500),
  description: text,
  location: z.string().max(1000),
  ...times,
};
export const actionShapes = {
  calendar_create: z
    .object({ ...details, attendees: z.array(z.email()).max(50) })
    .strict(),
  calendar_update: z.object({ ...existing, ...details }).strict(),
  calendar_rsvp: z
    .object({
      ...existing,
      response: z.enum(["accepted", "declined", "tentative"]),
    })
    .strict(),
  calendar_cancel: z.object(existing).strict(),
  document_create: z
    .object({ title: z.string().min(1).max(500), text })
    .strict(),
  document_edit: z
    .object({
      documentId: id,
      expectedTitle: z.string().min(1).max(500),
      acknowledgeShared: z.boolean(),
      expectedRevisionId: id,
      tabId: id,
      edit: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("append"), text: text.min(1) }).strict(),
        z
          .object({
            kind: z.literal("replace"),
            find: text.min(1),
            replacement: text,
            expectedOccurrences: z.number().int().min(1).max(1000),
          })
          .strict(),
      ]),
    })
    .strict(),
};
const descriptions = {
  calendar_create:
    "Create a timed event on the verified owner's primary calendar. Sends invitations to the exact attendees. No recurring series. Times require UTC offsets.",
  calendar_update:
    "Change the title, description, location and times of an existing company-organized event or single occurrence. Preserves guests; notifies all existing guests. Requires the read event's etag.",
  calendar_rsvp:
    "Set only the company's own attendee response and notify the organizer. Requires the read event's etag. Single events/occurrences only.",
  calendar_cancel:
    "Cancel a company-organized event or single occurrence and notify all guests. Recurring series cannot be cancelled through this tool.",
  document_create:
    "Create a Google Doc containing the exact text, privately in the company account's My Drive root. Does not share it or move it into a shared folder.",
  document_edit:
    "Append exact text or replace literal text in one explicit Google Docs tab. Read document first. Requires revision ID and expected replacement count. Preserves other tabs and formatting outside replaced text. Existing collaborators see the edit.",
};
export const googleActionTools = Object.entries(actionShapes).map(
  ([name, schema]) => ({
    name,
    description: descriptions[name],
    inputSchema: z.toJSONSchema(schema),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    },
  }),
);
export function parseGoogleAction(name, input) {
  if (!Object.hasOwn(actionShapes, name)) throw Error("Unknown Google action");
  const args = actionShapes[name].parse(input);
  if (args.start && Date.parse(args.end) <= Date.parse(args.start))
    throw Error("End must follow start");
  return args;
}
