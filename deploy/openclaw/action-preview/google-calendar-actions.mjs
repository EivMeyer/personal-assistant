import { ownerProfile } from "./owner-profile.mjs";
import { COMPANY_EMAIL } from "./google-auth.mjs";
export const eventBase =
  "https://www.googleapis.com/calendar/v3/calendars/primary/events";
function checkEventVersion(event, args) {
  if (event.etag !== args.expectedEtag)
    throw Error("Event changed; read it and request a fresh approval");
  if (
    (event.summary ?? "") !== args.expectedSummary ||
    event.organizer?.email !== args.expectedOrganizer
  )
    throw Error("Event title or organizer differs from the approved preview");
  const emails = (event.attendees ?? []).map((a) => a.email).sort();
  if (
    JSON.stringify(emails) !==
    JSON.stringify([...args.expectedAttendees].sort())
  )
    throw Error("Event recipients differ from the approved preview");
  if (event.recurrence?.length)
    throw Error("Recurring series writes are disabled; select one occurrence");
  if (event.status === "cancelled") throw Error("Event is already cancelled");
}
export function checkEvent(event, args, name) {
  checkEventVersion(event, args);
  if (name === "calendar_rsvp") {
    if (
      !event.attendees?.some(
        (a) => a.self === true && a.email === COMPANY_EMAIL,
      )
    )
      throw Error("Company attendee was not found");
  } else if (
    event.organizer?.email !== COMPANY_EMAIL ||
    event.organizer?.self !== true
  ) {
    throw Error("Only company-organized events can be changed or cancelled");
  }
}
function eventDetails(args) {
  return {
    summary: args.summary,
    description: args.description,
    location: args.location,
    start: { dateTime: args.start, timeZone: ownerProfile().timezone },
    end: { dateTime: args.end, timeZone: ownerProfile().timezone },
  };
}
export async function calendarOperation(name, args, get) {
  if (name === "calendar_create") {
    return {
      url: eventBase + "?sendUpdates=all",
      method: "POST",
      body: JSON.stringify({
        ...eventDetails(args),
        attendees: args.attendees.map((email) => ({ email })),
      }),
    };
  }
  const url = eventBase + "/" + encodeURIComponent(args.eventId);
  checkEvent(await get(url), args, name);
  const base = {
    url: url + "?sendUpdates=all",
    headers: { "If-Match": args.expectedEtag },
  };
  if (name === "calendar_cancel") return { ...base, method: "DELETE" };
  const body =
    name === "calendar_rsvp"
      ? {
          attendeesOmitted: true,
          attendees: [{ email: COMPANY_EMAIL, responseStatus: args.response }],
        }
      : eventDetails(args);
  return { ...base, method: "PATCH", body: JSON.stringify(body) };
}
