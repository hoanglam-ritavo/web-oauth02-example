export interface Profile {
  sub: string;
  name: string;
  email: string;
  employee_id: string | null;
  phone_number: string | null;
  is_developer: boolean;
  groups: "EMPLOYEE" | "CUSTOMER" | "ENTERPRISE";
}

export const validSubject = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function parseProfile(data: unknown, expectedSubject: string): Profile {
  if (!record(data) || data._id !== expectedSubject)
    throw new Error("Userinfo subject mismatch.");
  if (
    typeof data.name !== "string" || typeof data.email !== "string" ||
    (data.employee_id !== null && typeof data.employee_id !== "string") ||
    (data.phone_number !== null && typeof data.phone_number !== "string") ||
    typeof data.is_developer !== "boolean" ||
    (data.groups !== "EMPLOYEE" && data.groups !== "CUSTOMER" && data.groups !== "ENTERPRISE")
  ) throw new Error("Invalid userinfo.");
  return {
    sub: expectedSubject,
    name: data.name,
    email: data.email,
    employee_id: data.employee_id,
    phone_number: data.phone_number,
    is_developer: data.is_developer,
    groups: data.groups,
  };
}
