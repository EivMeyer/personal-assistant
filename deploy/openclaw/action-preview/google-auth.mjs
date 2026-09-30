import { ownerProfile } from "./owner-profile.mjs";
import { readFile } from "node:fs/promises";

export const COMPANY_EMAIL = ownerProfile().workEmail;
export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/drive.readonly",
];
export const GOOGLE_ACTION_SCOPES = [
  ...GOOGLE_SCOPES,
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/documents",
];
export async function googleJson(url, options = {}, request = fetch) {
  const response = await request(url, {
    ...options,
    redirect: "error",
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok)
    throw Error("Google request failed (HTTP " + response.status + ")");
  return response.json();
}
export function verifyCompany(profile) {
  if (profile.email !== COMPANY_EMAIL || profile.email_verified !== true)
    throw Error(
      "Company Google identity could not be verified; no personal-account fallback",
    );
}
export async function companyToken(settings, request = fetch) {
  const keys = JSON.parse(
    await readFile(settings.clientPath, "utf8"),
  ).installed;
  const saved = JSON.parse(await readFile(settings.tokenPath, "utf8"));
  if (saved.email !== COMPANY_EMAIL)
    throw Error("Expected company Google credentials");
  const auth = await googleJson(
    "https://oauth2.googleapis.com/token",
    {
      method: "POST",
      body: new URLSearchParams({
        client_id: keys.client_id,
        client_secret: keys.client_secret,
        refresh_token: saved.refresh_token,
        grant_type: "refresh_token",
      }),
    },
    request,
  );
  if (typeof auth.access_token !== "string")
    throw Error("Google token refresh failed");
  const headers = { Authorization: "Bearer " + auth.access_token };
  verifyCompany(
    await googleJson(
      "https://openidconnect.googleapis.com/v1/userinfo",
      { headers },
      request,
    ),
  );
  return headers;
}
