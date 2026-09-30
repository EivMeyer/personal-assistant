import { randomBytes } from "node:crypto";
export const documentUrl = (id) =>
  "https://docs.googleapis.com/v1/documents/" + encodeURIComponent(id);
export const fileUrl = (id) =>
  "https://www.googleapis.com/drive/v3/files/" +
  encodeURIComponent(id) +
  "?supportsAllDrives=true&fields=id,name,mimeType,version,modifiedTime,owners,permissions,capabilities,parents,trashed,shared";
function findTab(tabs, id) {
  for (const tab of tabs ?? []) {
    if (tab.documentTab && tab.tabProperties?.tabId === id)
      return tab.documentTab;
    const found = findTab(tab.childTabs, id);
    if (found) return found;
  }
}
function collectText(value) {
  if (!value || typeof value !== "object") return "";
  if (value.textRun) return value.textRun.content ?? "";
  return Object.values(value)
    .map((item) => (typeof item === "object" ? collectText(item) : ""))
    .join("");
}
export function documentEditRequest(doc, args) {
  if (!doc.revisionId || doc.revisionId !== args.expectedRevisionId)
    throw Error("Document changed; read it and request a fresh approval");
  const tab = findTab(doc.tabs, args.tabId);
  if (!tab) throw Error("Document tab not found");
  if (args.edit.kind === "append")
    return {
      insertText: {
        endOfSegmentLocation: { tabId: args.tabId },
        text: args.edit.text,
      },
    };
  const count = collectText(tab).split(args.edit.find).length - 1;
  if (count !== args.edit.expectedOccurrences)
    throw Error("Replacement match count changed or is incorrect");
  return {
    replaceAllText: {
      containsText: { text: args.edit.find, matchCase: true },
      replaceText: args.edit.replacement,
      tabsCriteria: { tabIds: [args.tabId] },
    },
  };
}
function createDocument(args) {
  const boundary = "secretary_" + randomBytes(24).toString("hex");
  const metadata = {
    name: args.title,
    mimeType: "application/vnd.google-apps.document",
    parents: ["root"],
  };
  const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${args.text}\r\n--${boundary}--\r\n`;
  return {
    url: "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&ignoreDefaultVisibility=true&fields=id,name,webViewLink",
    method: "POST",
    headers: { "Content-Type": "multipart/related; boundary=" + boundary },
    body,
  };
}
export async function documentOperation(name, args, get) {
  if (name === "document_create") return createDocument(args);
  const metadata = await get(fileUrl(args.documentId));
  if (
    metadata.trashed ||
    metadata.mimeType !== "application/vnd.google-apps.document" ||
    !metadata.capabilities?.canEdit
  )
    throw Error("Target is not an editable Google Doc");
  if (metadata.name !== args.expectedTitle)
    throw Error("Document title differs from the approved preview");
  if (metadata.shared && !args.acknowledgeShared)
    throw Error(
      "Shared document edit needs explicit acknowledgment in the preview",
    );
  const doc = await get(
    documentUrl(args.documentId) + "?includeTabsContent=true",
  );
  return {
    url: documentUrl(args.documentId) + ":batchUpdate",
    method: "POST",
    body: JSON.stringify({
      requests: [documentEditRequest(doc, args)],
      writeControl: { requiredRevisionId: args.expectedRevisionId },
    }),
  };
}
