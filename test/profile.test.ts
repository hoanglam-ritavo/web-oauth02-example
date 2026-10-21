import { test } from "node:test";
import assert from "node:assert/strict";
import { parseProfile } from "../src/auth/profile.js";
import { profileFields } from "./profile-fixture.js";

const subject = "12345678-1234-4123-8123-123456789012";
const userinfo = () => ({
  _id: subject, name: "Nguyễn An", email: "an@example.invalid",
  employee_id: null, phone_number: null, is_developer: false,
  groups: "EMPLOYEE", ...profileFields(),
});

test("preserves provider values, strips unknown keys and owns all nested data", () => {
  const input = {
    ...userinfo(), secret: "excluded",
    position: {
      ...profileFields().position, extra: "excluded",
      parser: { ...profileFields().position.parser, extra: "excluded" },
    },
  };
  const result = parseProfile(input, subject);
  const { _id, ...expected } = userinfo();
  assert.deepEqual(result, { sub: _id, ...expected });
  assert.notEqual(result.position, input.position);
  assert.notEqual(result.position.parser, input.position.parser);
  assert.notEqual(result.position.parser.others, input.position.parser.others);
  input.position.parser.others.push("changed");
  input.position.parser.company = "changed";
  assert.deepEqual(result.position, expected.position);
});

test("accepts nulls, empty strings and the backend empty position", () => {
  const input = userinfo();
  input.avatar = null;
  input.position.text = null;
  for (const field of Object.keys(input.position.parser)) {
    if (field !== "others") Reflect.set(input.position.parser, field, "");
  }
  input.position.parser.others = [];
  input.name = "";
  input.email = "";
  assert.deepEqual(parseProfile(input, subject).position, input.position);
  assert.equal(parseProfile(input, subject).avatar, null);
  input.avatar = "";
  input.position.text = "";
  assert.equal(parseProfile(input, subject).avatar, "");
  assert.equal(parseProfile(input, subject).position.text, "");
});

test("rejects missing or mistyped fields at every level", () => {
  const base = userinfo();
  const reject = (input: unknown) =>
    assert.throws(() => parseProfile(input, subject), /^Error: Invalid userinfo\.$/);
  for (const field of Object.keys(base).filter(field => field !== "_id")) {
    const missing = { ...base };
    Reflect.deleteProperty(missing, field);
    reject(missing);
    reject({ ...base, [field]: undefined });
    reject({ ...base, [field]: 42 });
  }
  for (const field of ["text", "parser"]) {
    const position = { ...base.position };
    Reflect.deleteProperty(position, field);
    reject({ ...base, position });
  }
  for (const field of Object.keys(base.position.parser)) {
    const parser = { ...base.position.parser };
    Reflect.deleteProperty(parser, field);
    reject({ ...base, position: { ...base.position, parser } });
    for (const invalid of [undefined, null, 42, false, {}, ...(field === "others" ? [] : [[]])]) {
      reject({ ...base, position: {
        ...base.position, parser: { ...base.position.parser, [field]: invalid },
      } });
    }
  }
  reject({ ...base, position: { ...base.position, text: false } });
  for (const invalid of [null, [], ""]) {
    reject({ ...base, position: invalid });
    reject({ ...base, position: { ...base.position, parser: invalid } });
  }
  for (const invalid of ["", [1], ["valid", null], [false], [{}]]) {
    reject({ ...base, position: {
      ...base.position, parser: { ...base.position.parser, others: invalid },
    } });
  }
  reject({ ...base, groups: "DEVELOPER" });
  reject({ ...base, is_developer: "false" });
});

test("requires the provider _id to match the verified JWT subject", () => {
  for (const input of [null, [], {}, { sub: subject }, { ...userinfo(), _id: "other" }]) {
    assert.throws(() => parseProfile(input, subject), /^Error: Userinfo subject mismatch\.$/);
  }
});
