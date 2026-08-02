export class SalesforceIdError extends Error {
  readonly code = "salesforce_id_invalid";

  constructor(message: string) {
    super(message);
    this.name = "SalesforceIdError";
  }
}

const SALESFORCE_ID = /^[A-Za-z0-9]+$/;
const CHECKSUM_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";

/** Convert a case-sensitive Salesforce 15-character id to canonical 18-char form. */
export function normalizeSalesforceId(value: string): string {
  const id = value.trim();
  if ((id.length !== 15 && id.length !== 18) || !SALESFORCE_ID.test(id)) {
    throw new SalesforceIdError("Salesforce id must be 15 or 18 ASCII alphanumeric characters");
  }
  const source = id.slice(0, 15);
  let suffix = "";
  for (let offset = 0; offset < 15; offset += 5) {
    let bits = 0;
    for (let index = 0; index < 5; index += 1) {
      const character = id[offset + index]!;
      if (character >= "A" && character <= "Z") bits |= 1 << index;
    }
    suffix += CHECKSUM_ALPHABET[bits];
  }
  const canonical = `${source}${suffix}`;
  if (id.length === 18 && id !== canonical) {
    throw new SalesforceIdError("Salesforce 18-character id has an invalid checksum");
  }
  return canonical;
}
