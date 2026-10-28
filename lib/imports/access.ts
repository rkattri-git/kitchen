import { timingSafeEqual } from "node:crypto";

export function importAccessError(request: Request): { status: number; message: string } | undefined {
  if (process.env.NODE_ENV !== "production") return undefined;
  const expected = process.env.KITCHEN_IMPORT_TOKEN;
  if (!expected) return { status: 503, message: "Import access is not configured on the server." };
  const actual = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  const matches = expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
  return matches ? undefined : { status: 401, message: "Enter the import access token to continue." };
}

